// Git plugin end-to-end: a dummy ticket edits files in its worktree via `/bash`, then the app's
// Changes tab (plugin iframe) must show them, follow the theme, and refresh live.
// Used by scripts/real-service.ts and scripts/changes.ts.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Ticket, TicketDetail, TranscriptEntry } from "@harness/shared";
import { until, type launchApp } from "./drive";

type App = Awaited<ReturnType<typeof launchApp>>;
type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-c", "user.name=Harness Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

/** A small repo on main with a few files the agent will add to, edit, rename and delete. */
export async function seedRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harness-changes-repo-"));
  const files: Record<string, string> = {
    "README.md": "# Greeter\n\nSays hello.\n\n## Usage\n\n```sh\nbun src/app.ts\n```\n",
    "src/app.ts": [
      'import { readFileSync } from "node:fs";',
      "",
      "export function main(argv: string[]) {",
      '  const name = argv[2] ?? "world";',
      '  console.log("Hello, " + name);',
      "  return 0;",
      "}",
      "",
      "const config = JSON.parse(readFileSync(\"config.json\", \"utf8\"));",
      "if (config.verbose) console.log(\"verbose mode\");",
      "",
      "main(process.argv);",
      "",
    ].join("\n"),
    "config.json": '{\n  "verbose": false\n}\n',
    "old-notes.txt": "Some notes that get moved.\n",
    "scratch.txt": "delete me\n",
  };
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "Initial commit");
  return dir;
}

// One line (the dummy driver's /bash takes the rest of the line). Commits a new module, then leaves
// an uncommitted edit, a staged rename, a deletion and an untracked file in the worktree.
const AGENT_SCRIPT = [
  "mkdir -p src/lib docs",
  `printf '%s\\n' 'export function greet(name: string, excited = false) {' '  const base = "Hello, " + name;' '  return excited ? base + "!" : base;' '}' > src/lib/greet.ts`,
  "git add -A",
  "git -c user.name=Agent -c user.email=agent@example.com -c commit.gpgsign=false commit -qm 'Add greet helper'",
  `printf '%s\\n' 'import { greet } from "./lib/greet";' | cat - src/app.ts > src/app.next`,
  "mv src/app.next src/app.ts",
  `sed -i '' 's/console.log("Hello, " + name);/console.log(greet(name, true));/' src/app.ts`,
  `sed -i '' 's/"verbose": false/"verbose": true/' config.json`,
  "git mv old-notes.txt docs/notes.txt",
  "rm scratch.txt",
  `printf '%s\\n' '# Changelog' '' '- Greet with an exclamation mark' > CHANGELOG.md`,
].join(" && ");

export async function checkChangesTab(opts: { api: Api; app: App; check: Check; shot: (name: string) => Promise<void>; setTheme?: (t: "light" | "dark") => Promise<void> }) {
  const { api, app, check, shot } = opts;
  const repo = await seedRepo();
  const project = await api<Project>("POST", "/projects", { path: repo, name: "greeter", key: "GREET", useWorktrees: true });
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: `Add a greet helper\n/bash ${AGENT_SCRIPT}`, driver: "dummy", start: true });
  const settled = await until(
    "changes ticket reaches review",
    async () => {
      const t = (await api<TicketDetail>("GET", `/tickets/${ticket.key}`)).ticket;
      return (t.status === "review" || t.status === "blocked") && !t.busy ? t : null;
    },
    120000,
  );
  if (settled.status === "blocked") throw new Error(`changes ticket blocked: ${settled.blockedReason ?? JSON.stringify(settled.pendingApproval)}`);
  const transcript = await api<TranscriptEntry[]>("GET", `/sessions/${settled.sessionId}/transcript?after=0`);
  const bash = transcript.find((e) => e.content.type === "tool_result" && e.content.name === "bash")?.content;
  const bashOut = bash?.type === "tool_result" ? bash.output.map((o) => (o.type === "text" ? o.text : "")).join("") : "no bash tool result";
  check("worktree ticket ran the /bash edits", !!settled.branch && !!settled.workdir && bash?.type === "tool_result" && !bash.isError, `${settled.branch} @ ${settled.workdir} ${bashOut.slice(0, 300)}`);

  const tabs = await api<{ pluginId: string; id: string }[]>("GET", `/tickets/${ticket.key}/tabs`);
  check("service offers the git Changes tab for a worktree ticket", tabs.some((t) => t.pluginId === "git" && t.id === "changes"));

  await app.go(`#/board/${project.id}/ticket/${ticket.key}`);
  await until("Changes tab button", () => app.exists(`[data-plugin-tab="plugin:git:changes"]`), 10000);
  check("Changes tab shows after the built-in tabs", await app.js<boolean>(`(() => { const tabs = [...document.querySelectorAll(".tabs .tab")].map(t => t.textContent.trim()); return tabs.indexOf("Changes") > tabs.indexOf("Details"); })()`));
  await app.clickText(".tabs .tab", "Changes");
  await until("iframe", () => app.exists("iframe.plugin-frame"));
  const frame = await app.frame("/plugins/git/ui/");
  const stat = await until("plugin rendered stats", () => frame.js<string>(`document.querySelector(".bar .stat")?.textContent ?? ""`), 20000).catch(async (e) => {
    await frame.cdp("Log.enable");
    await frame.cdp("Runtime.enable");
    await Bun.sleep(300);
    const res = await frame.js<string>(`JSON.stringify(performance.getEntriesByType("resource").map((e) => [e.name.split("/").pop(), e.responseStatus, Math.round(e.duration)]))`).catch((x) => String(x));
    const logs = frame.events.map((ev) => JSON.stringify(ev.params).slice(0, 400)).join("\n");
    const dump = `${res}\n${logs}\n` + (await frame.js<string>(`location.href + "\\n" + document.body.outerHTML.slice(0, 400)`).catch((x) => String(x)));
    throw new Error(`${(e as Error).message}\nframe: ${dump}`);
  });
  check("header shows +/- across N files", /\+\d+.*−\d+.*across 6 files/.test(stat), stat);
  const bar = await frame.js<string>(`document.querySelector(".bar").textContent`);
  check("header shows branch → base and the commit count", bar.includes(settled.branch!) && bar.includes("main") && bar.includes("1 commit"), bar);
  const treeRows = await until(
    "file tree rows",
    () => frame.js<string[]>(`(() => { const host = document.querySelector(".files file-tree-container, .files [data-file-tree], .files > *"); const root = host?.shadowRoot ?? host; return [...(root?.querySelectorAll("[data-item-path]") ?? [])].map(e => e.getAttribute("data-item-path")); })()`).then((r) => (r?.length ? r : null)),
    10000,
  ).catch(() => [] as string[]);
  check("file tree lists the changed files", ["CHANGELOG.md", "src/lib/greet.ts", "src/app.ts"].every((p) => treeRows.some((r) => r?.includes(p))), treeRows.join(", "));
  const deco = await frame.js<{ html: string; colors: string[] }>(`(() => {
    const host = [...document.querySelectorAll(".files *")].find((e) => e.shadowRoot);
    const row = [...(host?.shadowRoot?.querySelectorAll("[data-item-path]") ?? [])].find((e) => e.getAttribute("data-item-path") === "src/app.ts");
    const spans = [...(row?.querySelectorAll("span[title] > span") ?? [])];
    return { html: row?.outerHTML.slice(-600) ?? "", colors: spans.map((s) => getComputedStyle(s).color) };
  })()`);
  check("tree counts color additions and deletions differently", deco.colors.length >= 2 && deco.colors[0] !== deco.colors.at(-1), JSON.stringify(deco.colors) + (deco.colors.length < 2 ? " " + deco.html : ""));
  const diffs = await until("diff items rendered", () => frame.js<number>(`document.querySelectorAll(".diffs diffs-container").length`), 15000).catch(() => 0);
  check("diffs render (CodeView items)", diffs > 0, `${diffs} rendered`);
  await Bun.sleep(900); // syntax highlighting lands asynchronously
  await shot("8-changes");
  check("narrow panel hides the tree behind a toggle", await frame.js<boolean>(`document.getElementById("app").classList.contains("narrow")`));

  // Expanded detail panel: the tree sits beside the diffs.
  await app.js(`document.querySelector('.detail-titlebar button[title="Expand"]')?.click()`);
  const wide = await until("plugin goes wide", () => frame.js<boolean>(`!document.getElementById("app").classList.contains("narrow")`), 5000).catch(() => false);
  check("expanded panel shows the file tree beside the diffs", !!wide);
  await Bun.sleep(800);
  await shot("8-changes-wide");

  if (opts.setTheme) {
    await opts.setTheme("dark");
    const t = await until("plugin theme follows", () => frame.js<string>(`document.documentElement.dataset.theme === "dark" ? "dark" : ""`), 5000).catch(() => "");
    check("theme change reaches the plugin iframe (harness:theme)", t === "dark");
    await Bun.sleep(700);
    await shot("8-changes-wide-dark");
    await app.js(`document.querySelector('.detail-titlebar button[title="Show the board"]')?.click()`);
    await Bun.sleep(700);
    await shot("8-changes-dark");
    await opts.setTheme("light");
  } else {
    await app.js(`document.querySelector('.detail-titlebar button[title="Show the board"]')?.click()`);
    const t = await frame.js<string>(`document.documentElement.dataset.theme`);
    const host = await app.js<string>(`document.documentElement.dataset.theme`);
    check("plugin iframe uses the app's resolved theme", t === host, `${t} vs ${host}`);
  }

  // Split view toggle.
  await frame.js(`[...document.querySelectorAll(".seg button")].find(b => b.textContent === "Split").click()`);
  const split = await frame.js<boolean>(`document.querySelector(".seg button.on")?.textContent === "Split"`);
  check("unified/split toggle", split);
  await Bun.sleep(600);
  await shot("9-changes-split");

  // Live refresh: a follow-up run writes another file; the ticket.upserted events reach the plugin.
  await api("POST", `/tickets/${ticket.key}/messages`, { text: "/bash printf 'late\\n' > LATE.md" });
  const late = await until("live refresh shows LATE.md", () => frame.js<boolean>(`document.querySelector(".bar .stat")?.textContent.includes("across 7 files")`), 30000).catch(() => false);
  check("plugin refreshes live as the agent works", !!late);
  frame.close();
  return { project, ticket: settled, repo };
}
