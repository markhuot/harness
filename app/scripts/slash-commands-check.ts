// The /command autocomplete end to end in the built app, against the REAL service (throwaway
// HARNESS_HOME) with the claude-code driver pointed at the fake CLI, which reports a few commands
// from `initialize`: typing `/co` at the start of a New session lists the agent's commands and
// skills with their descriptions, Enter completes one, a `/` later in the text is plain text, `@`
// still lists files, the started session's prompt reaches the CLI exactly as typed, and the ticket
// composer offers the same list.
//
//   bun run build && bun scripts/slash-commands-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-slash-home-");
const projectDir = tempDir("harness-slash-project-");
mkdirSync(join(projectDir, "src"));
writeFileSync(join(projectDir, "src/app.ts"), "export {};\n");
const record = join(tempDir("harness-slash-record-"), "claude.ndjson");
const COMMANDS = [
  { name: "code-walk", description: "Walk a user through a piece of code so they can perform a detailed code review. (user)", argumentHint: "" },
  { name: "commit-and-pr", description: "Commit and PR (user)", argumentHint: "" },
  { name: "code-review", description: "Review the current diff for correctness bugs", argumentHint: "[pr number]" },
  { name: "vercel:deploy", description: "(vercel) Deploy the current project to Vercel.", argumentHint: "[prod]" },
  { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "" },
];

const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: {
    ...process.env,
    HARNESS_HOME: home,
    HARNESS_PORT: String(port),
    HARNESS_CLAUDE_BIN: join(appDir, "..", "service/src/drivers/__fixtures__/fake-claude.ts"),
    FAKE_CLAUDE_COMMANDS: JSON.stringify(COMMANDS),
    FAKE_CLAUDE_RECORD: record,
  },
  stdout: "ignore",
  stderr: "inherit",
});

const counter = checker();
const { check } = counter;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
const shot = async (name: string) => {
  if (!shots || !app) return;
  await Bun.sleep(400);
  await app.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "slash", key: "SLASH", defaultDriver: "claude-code" });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, exists, go, key, type, cmdEnter } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("slash")`), 10000);
  await go(`#/board/${project.id}`);
  await until("board", () => exists('[data-testid="pane-board"]'), 10000);

  const menu = () =>
    js<{ label: string; rows: { name: string; text: string }[] } | null>(`(() => {
      const m = document.querySelector(".mention-menu");
      return m && m.style.visibility !== "hidden" ? { label: m.getAttribute("aria-label"), rows: [...m.querySelectorAll("li")].map(li => ({ name: li.querySelector(".mention-name").textContent, text: li.textContent })) } : null;
    })()`);
  const value = (sel: string) => js<string>(`document.querySelector(${JSON.stringify(sel)}).value`);

  // 1. A New session on the project: "/co" lists the agent's commands, best first, described.
  await key("n", "KeyN", 78, 4);
  await until("New session pane", () => exists("[data-testid=pane-compose] .draft-prompt"), 10000);
  // Typing saves a draft, and the pane then shows it as a ticket: find the prompt by itself.
  const prompt = ".draft-prompt";
  await type(prompt, "/co");
  // The first lookup starts the CLI, so give it a moment.
  const listed = await until("commands for /co", async () => {
    const m = await menu();
    return m?.label === "Commands" && m.rows.length ? m : null;
  }, 15000);
  check(
    "/co lists the commands that start with it, in the CLI's order",
    JSON.stringify(listed.rows.map((r) => r.name)) === JSON.stringify(["/code-walk", "/commit-and-pr", "/code-review", "/compact"]),
    JSON.stringify(listed.rows.map((r) => r.name)),
  );
  check("each row shows the command's description", listed.rows[0]!.text.includes("Walk a user through a piece of code"), listed.rows[0]!.text);
  check("an argument hint shows next to its command", listed.rows.find((r) => r.name === "/code-review")?.text.includes("[pr number]") === true);
  await shot("slash-commands-new-session");

  // 2. Enter picks the highlighted one: the name and a space, ready for its arguments.
  await key("Enter", "Enter", 13);
  await until("the command inserted", async () => (await value(prompt)) === "/code-walk ");
  check("Enter completes /code-walk and closes the list", (await value(prompt)) === "/code-walk " && !(await menu()));

  // 3. A part of a plugin command's name matches too.
  await type(prompt, "/deploy");
  const plugin = await until("commands for /deploy", async () => (await menu())?.rows);
  check("/deploy finds vercel:deploy", plugin.length === 1 && plugin[0]!.name === "/vercel:deploy", JSON.stringify(plugin));

  // 4. Only a leading / is a command; @ still lists files.
  await type(prompt, "look at /co");
  await Bun.sleep(400);
  check("a / later in the text doesn't open the list", !(await menu()));
  await type(prompt, "/code-walk @sr");
  const files = await until("files for @sr", async () => {
    const m = await menu();
    return m?.label === "Files" ? m : null;
  });
  check("an @ in a command's arguments still lists files", files.rows.some((r) => r.name === "src/"), JSON.stringify(files.rows));

  // 5. Start it: the CLI gets the prompt as typed, so it expands the skill itself.
  await type(prompt, "/code-walk this branch");
  await Bun.sleep(300);
  await cmdEnter();
  const sent = await until(
    "an agent run's prompt",
    async () => {
      if (!existsSync(record)) return null;
      const runs = readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string }).filter((r) => r.argv.includes("--mcp-config"));
      return runs[0]?.stdin ?? null;
    },
    15000,
  );
  check("the agent's first message starts with the command as typed", sent.startsWith("/code-walk this branch"), sent.slice(0, 120));

  // 6. The ticket composer offers the ticket agent's commands.
  const ticket = await until("the started ticket", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${project.id}`)).find((t) => !t.draft));
  await go(`#/board/${project.id}/ticket/${ticket.key}`);
  const composer = "[data-testid=pane-ticket] .composer-input";
  await until("composer", () => exists(composer), 10000);
  await type(composer, "/rev");
  const inComposer = await until("commands in the composer", async () => (await menu())?.rows);
  check("the composer lists /code-review for /rev", inComposer[0]?.name === "/code-review", JSON.stringify(inComposer));
  await shot("slash-commands-composer");
  await key("Tab", "Tab", 9);
  await until("the composer's command inserted", async () => (await value(composer)) === "/code-review ");
  check("Tab completes the command in the composer", (await value(composer)) === "/code-review ");
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
  await shot("slash-commands-failure").catch(() => {});
  const text = await app?.js<string>(`document.querySelector(".main")?.innerText.slice(0, 1500) ?? ""`).catch(() => "");
  if (text) console.log(`--- on screen ---\n${text}`);
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall slash command checks passed");
process.exit(counter.failures ? 1 : 0);
