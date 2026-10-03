// Changes tab end-to-end: a dummy ticket edits files in its worktree via `/bash`, then the app's
// built-in Changes tab (drawn from the git plugin's routes) must show them, follow the theme, and
// refresh live.
// Used by scripts/real-service.ts and scripts/changes.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket, TicketDetail, TranscriptEntry } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { until, type launchApp } from "./drive";

type App = Awaited<ReturnType<typeof launchApp>>;
type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-c", "user.name=Harness Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

/**
 * A small repo on main with a few files the agent will add to, edit, rename and delete. It's a
 * tempDir(): the caller removes it with cleanupTempDirs() once the daemon using it has stopped.
 */
export async function seedRepo(): Promise<string> {
  const dir = tempDir("harness-changes-repo-");
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
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: `Add a greet helper\n/tools ${JSON.stringify([{ name: "bash", input: { command: AGENT_SCRIPT } }])}`, driver: "dummy", start: true });
  // The default permission mode asks a human before the dummy agent's bash call: approve it (for
  // the tool) the way a person would, then wait for the run to finish. `/tools` (unlike `/bash`)
  // repeats the call when the answered approval resumes the run.
  let settled: Ticket | null = null;
  for (let round = 0; round < 3; round++) {
    settled = await until(
      "changes ticket reaches review",
      async () => {
        const t = (await api<TicketDetail>("GET", `/tickets/${ticket.key}`)).ticket;
        return (t.status === "review" || t.status === "blocked") && !t.busy ? t : null;
      },
      120000,
    );
    if (settled.status !== "blocked" || settled.pendingApproval?.toolName !== "bash") break;
    await api("POST", `/tickets/${ticket.key}/approval`, { decision: "allow_tool" });
    await Bun.sleep(300);
  }
  settled = settled!;
  if (settled.status === "blocked") throw new Error(`changes ticket blocked: ${settled.blockedReason ?? JSON.stringify(settled.pendingApproval)}`);
  const transcript = await api<TranscriptEntry[]>("GET", `/sessions/${settled.sessionId}/transcript?after=0`);
  const bash = transcript.findLast((e) => e.content.type === "tool_result" && e.content.name === "bash")?.content;
  const bashOut = bash?.type === "tool_result" ? bash.output.map((o) => (o.type === "text" ? o.text : "")).join("") : "no bash tool result";
  check("worktree ticket ran the /bash edits", !!settled.branch && !!settled.workdir && bash?.type === "tool_result" && !bash.isError, `${settled.branch} @ ${settled.workdir} ${bashOut.slice(0, 300)}`);

  const tabs = await api<{ pluginId: string; id: string }[]>("GET", `/tickets/${ticket.key}/tabs`);
  check("service offers the git Changes tab for a worktree ticket", tabs.some((t) => t.pluginId === "git" && t.id === "changes"));

  await app.go(`#/board/${project.id}/ticket/${ticket.key}`);
  await until("Changes tab button", () => app.exists(`.tabs [data-tab="changes"]`), 10000);
  const strip = await app.js<string[]>(`[...document.querySelectorAll(".tabs .tab")].map(t => t.textContent.trim())`);
  check("Changes sits after Browser, ahead of Details", strip.indexOf("Changes") === strip.indexOf("Browser") + 1 && strip.indexOf("Details") === strip.indexOf("Changes") + 1, strip.join(" | "));
  check("the git plugin's own Changes tab isn't listed too", !(await app.exists(`[data-plugin-tab="plugin:git:changes"]`)) && strip.filter((t) => t === "Changes").length === 1, strip.join(" | "));
  check("Changes has no icon, like the other built-in tabs", !(await app.exists(`.tabs [data-tab="changes"] svg`)));
  await app.clickText(".tabs .tab", "Changes");
  const stat = await until("changes rendered stats", () => app.js<string>(`document.querySelector(".changes-stat")?.textContent ?? ""`), 20000);
  check("drawn in the app, not a plugin iframe", !(await app.exists("iframe.plugin-frame")) && (await app.js<string>(`location.hash`)).endsWith("/changes"));
  check("header shows +/- across N files", /\+\d+.*−\d+.*across 6 files/.test(stat), stat);
  const bar = await app.js<string>(`document.querySelector(".changes-bar").textContent`);
  check("header shows branch → base and the commit count", bar.includes(settled.branch!) && bar.includes("main") && bar.includes("1 commit"), bar);
  // The tree draws in its own shadow root.
  const treeRoot = `[...document.querySelectorAll(".changes-files *")].find((e) => e.shadowRoot)?.shadowRoot`;
  const treeRows = await until("file tree rows", () => app.js<string[]>(`[...(${treeRoot}?.querySelectorAll("[data-item-path]") ?? [])].map(e => e.getAttribute("data-item-path"))`).then((r) => (r?.length ? r : null)), 10000).catch(() => [] as string[]);
  check("file tree lists the changed files", ["CHANGELOG.md", "src/lib/greet.ts", "src/app.ts"].every((p) => treeRows.some((r) => r?.includes(p))), treeRows.join(", "));
  const deco = await app.js<{ html: string; colors: string[] }>(`(() => {
    const row = [...(${treeRoot}?.querySelectorAll("[data-item-path]") ?? [])].find((e) => e.getAttribute("data-item-path") === "src/app.ts");
    const spans = [...(row?.querySelectorAll("span[title] > span") ?? [])];
    return { html: row?.outerHTML.slice(-600) ?? "", colors: spans.map((s) => getComputedStyle(s).color) };
  })()`);
  check("tree counts color additions and deletions differently", deco.colors.length >= 2 && deco.colors[0] !== deco.colors.at(-1), JSON.stringify(deco.colors) + (deco.colors.length < 2 ? " " + deco.html : ""));
  const diffs = await until("diff items rendered", () => app.js<number>(`document.querySelectorAll(".changes-diffs diffs-container").length`), 15000).catch(() => 0);
  check("diffs render (CodeView items)", diffs > 0, `${diffs} rendered`);
  await Bun.sleep(900); // syntax highlighting lands asynchronously
  await shot("8-changes");
  check("narrow panel hides the tree behind a toggle", await app.js<boolean>(`document.querySelector(".changes").classList.contains("narrow")`));
  const overlay = () => app.js<{ open: boolean; expanded: string | null }>(`({ open: document.querySelector(".changes").classList.contains("files-open"), expanded: document.querySelector(".changes-bar [data-action=files]")?.getAttribute("aria-expanded") ?? null })`);
  await app.js(`document.querySelector(".changes-bar [data-action=files]").click()`);
  const opened = await overlay();
  await app.js(`document.querySelector(".changes-bar [data-action=files]").click()`);
  const closed = await overlay();
  check("narrow files button opens and closes the overlay", opened.open && opened.expanded === "true" && !closed.open && closed.expanded === "false", JSON.stringify({ opened, closed }));

  // Maximized ticket pane: the tree sits beside the diffs.
  await app.js(`document.querySelector('.detail-titlebar [data-testid=pane-zoom]')?.click()`);
  const wide = await until("changes go wide", () => app.js<boolean>(`!document.querySelector(".changes").classList.contains("narrow")`), 5000).catch(() => false);
  check("expanded panel shows the file tree beside the diffs", !!wide);
  await Bun.sleep(800);
  await shot("8-changes-wide");

  // Leaving the tab and coming back remounts it, reading what was saved.
  const reopen = async () => {
    await app.clickText(".tabs .tab", "Spec");
    await until("changes unmounted", async () => !(await app.exists(".changes")), 5000);
    await app.clickText(".tabs .tab", "Changes");
    await until("changes back", () => app.js<boolean>(`!!document.querySelector(".changes-stat") && !!document.querySelector(".changes-diffs diffs-container")`), 20000);
  };

  // Collapse the docked sidebar: the diffs take its width, and the choice survives a remount.
  const sidebar = () =>
    app.js<{ files: number; diffs: number; expanded: string | null; collapsed: boolean }>(`(() => {
      const root = document.querySelector(".changes"), btn = document.querySelector(".changes-bar [data-action=files]");
      return { files: document.querySelector(".changes-files")?.getBoundingClientRect().width ?? 0, diffs: document.querySelector(".changes-diffs").getBoundingClientRect().width,
        expanded: btn?.getAttribute("aria-expanded") ?? null, collapsed: root.classList.contains("files-collapsed") };
    })()`);
  const open = await sidebar();
  await app.js(`document.querySelector(".changes-bar [data-action=files]").click()`);
  await Bun.sleep(400);
  const shut = await sidebar();
  check("files button collapses the docked sidebar", open.expanded === "true" && shut.expanded === "false" && shut.files === 0 && shut.collapsed, JSON.stringify({ open, shut }));
  check("diffs take the collapsed sidebar's width", shut.diffs >= open.diffs + open.files - 2, JSON.stringify({ open, shut }));
  const diffBox = await app.js<number>(`Math.round(document.querySelector(".changes-diffs diffs-container")?.getBoundingClientRect().width ?? 0)`);
  check("CodeView reflows into the wider column", diffBox > open.diffs, `${diffBox} vs ${open.diffs}`);
  await shot("8-changes-wide-collapsed");
  await reopen();
  check("collapsed sidebar persists across a remount", await app.js<boolean>(`document.querySelector(".changes").classList.contains("files-collapsed")`));
  await app.js(`document.querySelector(".changes-bar [data-action=files]").click()`);
  await until("sidebar back", () => app.js<boolean>(`(document.querySelector(".changes-files")?.getBoundingClientRect().width ?? 0) > 0`), 5000).catch(() => false);
  check("files button expands the sidebar again", (await sidebar()).expanded === "true");
  await Bun.sleep(600);

  // Viewed: checking it collapses the file's diff, the arrow peeks without unchecking, and marks survive a remount.
  const viewed = (path: string) =>
    app.js<{ found: boolean; checked: boolean; expanded: string | null; height: number; bar: string; tree: string }>(`(() => {
      const box = document.querySelector('.changes-viewed[data-path=${JSON.stringify(path)}] input');
      const arrow = document.querySelector('.changes-disclosure[data-path=${JSON.stringify(path)}]');
      const row = [...(${treeRoot}?.querySelectorAll("[data-item-path]") ?? [])].find((e) => e.getAttribute("data-item-path") === ${JSON.stringify(path)});
      return { found: !!box && !!arrow, checked: !!box?.checked, expanded: arrow?.getAttribute("aria-expanded") ?? null,
        height: Math.round(box?.closest("diffs-container")?.getBoundingClientRect().height ?? 0),
        bar: document.querySelector(".changes-viewed-count")?.textContent ?? "", tree: row?.textContent ?? "" };
    })()`);
  const headers = await app.js<{ boxes: number; arrows: number; items: number }>(`({ boxes: document.querySelectorAll(".changes-diffs .changes-viewed input[type=checkbox]").length, arrows: document.querySelectorAll(".changes-diffs .changes-disclosure[aria-expanded]").length, items: document.querySelectorAll(".changes-diffs diffs-container").length })`);
  check("every rendered diff header has a Viewed checkbox and a disclosure arrow", headers.items > 0 && headers.boxes === headers.items && headers.arrows === headers.items, JSON.stringify(headers));
  const before = await viewed("src/app.ts");
  check("files start unviewed and expanded", before.found && !before.checked && before.expanded === "true" && before.bar === "0 / 6 viewed", JSON.stringify(before));
  await app.js(`document.querySelector('.changes-viewed[data-path="src/app.ts"] input').click()`);
  await Bun.sleep(400);
  const marked = await viewed("src/app.ts");
  check("checking Viewed collapses the diff", marked.checked && marked.expanded === "false" && marked.height < before.height / 2, JSON.stringify({ before, marked }));
  check("viewed count and tree check follow", marked.bar === "1 / 6 viewed" && marked.tree.includes("✓"), JSON.stringify(marked));
  await shot("8-changes-viewed");
  await app.js(`document.querySelector('.changes-disclosure[data-path="src/app.ts"]').click()`);
  await Bun.sleep(400);
  const peek = await viewed("src/app.ts");
  check("the disclosure arrow expands a viewed file without unchecking it", peek.checked && peek.expanded === "true" && peek.height > marked.height * 2, JSON.stringify(peek));
  await app.js(`document.querySelector('.changes-viewed[data-path="CHANGELOG.md"] input').click(); document.querySelector('.changes-viewed[data-path="config.json"] input').click()`);
  await Bun.sleep(300);
  await reopen();
  await until("viewed boxes back", () => app.exists('.changes-viewed[data-path="src/app.ts"]'), 10000).catch(() => false);
  await Bun.sleep(400);
  const reloaded = await viewed("src/app.ts");
  check("viewed marks persist across a remount (collapsed again; the peek isn't kept)", reloaded.checked && reloaded.expanded === "false" && reloaded.bar === "3 / 6 viewed", JSON.stringify(reloaded));
  await app.js(`document.querySelector('.changes-viewed[data-path="src/app.ts"] input').click()`);
  await Bun.sleep(400);
  const unmarked = await viewed("src/app.ts");
  check("unchecking Viewed expands the file", !unmarked.checked && unmarked.expanded === "true" && unmarked.bar === "2 / 6 viewed", JSON.stringify(unmarked));

  if (opts.setTheme) {
    await opts.setTheme("dark");
    await Bun.sleep(700);
    await shot("8-changes-wide-dark");
    // A dark → dark switch (Harness Dark → Catppuccin Mocha) recolors the tab from the app's tokens.
    await app.js(`window.harness.setTheme({ darkTheme: "catppuccin-mocha" })`);
    const mocha = await until(
      "changes get Mocha",
      async () => {
        const bg = await app.js<string>(`getComputedStyle(document.querySelector(".changes-diffs")).getPropertyValue("--bg").trim() + " " + getComputedStyle(document.querySelector(".changes-files")).backgroundColor`);
        return bg.startsWith("#181825") && bg;
      },
      5000,
    ).catch(() => null);
    check("the color theme reaches the Changes tab (app tokens)", !!mocha, String(mocha));
    await Bun.sleep(900);
    await shot("8-changes-wide-mocha");
    await app.js(`window.harness.setTheme({ darkTheme: "harness-dark" })`);
    await app.js(`document.querySelector('.detail-titlebar [data-testid=pane-zoom]')?.click()`);
    await Bun.sleep(700);
    await shot("8-changes-dark");
    await opts.setTheme("light");
  } else {
    await app.js(`document.querySelector('.detail-titlebar [data-testid=pane-zoom]')?.click()`);
  }

  // Split view toggle.
  await app.js(`document.querySelector('.changes-bar [data-action="split"]').click()`);
  const split = await app.js<boolean>(`document.querySelector(".changes-bar .segmented button.on")?.textContent === "Split"`);
  check("unified/split toggle", split);
  await Bun.sleep(600);
  await shot("9-changes-split");

  // Live refresh: a follow-up work run writes another file; the ticket events reach the tab. (`move`
  // sends the Review ticket back to work; without it the message is a chat, which doesn't run /bash.)
  // It also edits CHANGELOG.md, which was marked viewed: that file's mark resets, config.json's stays.
  await api("POST", `/tickets/${ticket.key}/messages`, { text: "/bash printf 'late\\n' > LATE.md && printf -- '- Later entry\\n' >> CHANGELOG.md", move: true });
  const late = await until("live refresh shows LATE.md", () => app.js<boolean>(`!!document.querySelector(".changes-stat")?.textContent.includes("across 7 files")`), 30000).catch(() => false);
  const served = await api<{ files: unknown[] }>("GET", `/plugins/git/api/changes?ticket=${ticket.key}`).then((c) => c.files.length, (e) => String(e));
  const after = await api<TicketDetail>("GET", `/tickets/${ticket.key}`).then((d) => `${d.ticket.status} busy=${d.ticket.busy}`);
  const tail = await api<TranscriptEntry[]>("GET", `/sessions/${settled.sessionId}/transcript?after=0`).then((t) => t.slice(-4).map((e) => JSON.stringify(e.content).slice(0, 200)).join(" / "));
  check("the tab refreshes live as the agent works", !!late, `service lists ${served} files; ticket ${after}; transcript …${tail}; tab says ${await app.js<string>(`document.querySelector(".changes-stat")?.textContent ?? ""`)}`);
  await Bun.sleep(400);
  const [changelog, config] = [await viewed("CHANGELOG.md"), await viewed("config.json")];
  const changelogText = await app.js<string>(`document.querySelector('.changes-viewed[data-path="CHANGELOG.md"]')?.closest("diffs-container")?.shadowRoot?.textContent ?? ""`);
  check("a viewed file the agent changes again goes back to unviewed and expanded", !changelog.checked && changelog.expanded === "true" && config.checked && config.expanded === "false" && config.bar === "1 / 7 viewed", JSON.stringify({ changelog, config }));
  check("the re-edited file's diff shows the new lines", changelogText.includes("Later entry"), changelogText.slice(0, 300));
  return { project, ticket: settled, repo };
}
