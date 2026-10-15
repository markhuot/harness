// What the iPhone walkthrough adds to dev-sim's GREET world: tickets for the Agents & tasks filter,
// a spec linking into a file, and the context gauge, plus the plan-usage proxy. They are created
// after GREET-1…6, so the keys the other screens use don't move.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { until } from "@harness/shared/testing/daemon";
import { setSessionContext, startCompactRun } from "@harness/shared/testing/seed";
import type { Project, Ticket, TicketDetail } from "@harness/shared";
import { startDaemonProxy } from "@harness/shared/testing/proxy";
import { GREETINGS_PATH, GREETING_FOR, SLASH_COMMANDS, greetings, usageFixture } from "../../ios/Tools/fixtures";
import type { Daemon, Seeded } from "../../ios/Tools/dev-sim";

/** The file the linked ticket's spec points into; pass it to dev-sim's `seed` so it's committed on main. */
export const WORLD_FILES = { [GREETINGS_PATH]: greetings(false) };

export type World = {
  tasks: Ticket; fileLink: Ticket; gauge: Ticket; gaugeMiss: Ticket; gaugeCompact: Ticket;
  conductor: Ticket; approval: Ticket; changes: Ticket; approvable: Ticket; messaging: Ticket; drafting: Ticket; branchPlan: Ticket; code: Ticket; slash: Project;
  nestedAgent: NonNullable<TicketDetail["subagents"]>[number];
};

export async function seedWorld(d: Daemon, seeded: Seeded): Promise<World> {
  const api = d.api;
  const create = (spec: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId: seeded.project.id, spec, driver: "dummy", start: true, skipAgentReview: true, ...extra });
  const detail = (key: string) => api<TicketDetail>("GET", `/tickets/${key}`);
  const settle = (t: Ticket, pred: (x: TicketDetail["ticket"]) => boolean = (x) => x.status === "review" && !x.busy) =>
    until(`${t.key} settles`, async () => ((x) => (pred(x) ? x : null))((await detail(t.key)).ticket), 60000);

  // A background Bash task ("Count to 30") and two sub-agents: the Agents & tasks tab lists all three.
  const tasks = await create("Count the greetings in the background\n/bgtask 30");
  await settle(tasks);
  await api("POST", `/tickets/${tasks.key}/messages`, { text: "/agents 2", move: true });
  await until(`${tasks.key} has its sub-agents`, async () => (((await detail(tasks.key)).subagents?.length ?? 0) >= 3 ? true : null), 30000, 200);
  await settle(tasks);

  const fileLink = await create(`Tidy the greetings\n\n[greetingFor fallback](${GREETINGS_PATH}#L${GREETING_FOR[0]}-L${GREETING_FOR[1]})`);
  await settle(fileLink, (x) => x.status === "review" && !x.busy && !!x.workdir);

  // Gauge tickets sit in planning (nothing runs on them) and are switched to the driver that reports
  // context; the numbers go straight into the sessions table, as the service's per-call recording would.
  const gaugeOf = async (name: string, c: { input: number; cacheRead: number; cacheWrite: number; misses?: number; missTokens?: number }) => {
    const t = await create(`Gauge ${name}`, { start: false });
    await settle(t, (x) => x.status === "planning" && !x.busy);
    const patched = await api<Ticket>("PATCH", `/tickets/${t.key}`, { driver: "claude-code" });
    setSessionContext(d.home, patched.sessionId, { output: 0, estimated: false, at: Date.now(), prefix: 50000, misses: 0, missTokens: 0, ...c });
    return patched;
  };
  const gauge = await gaugeOf("gauge", { input: 6000, cacheRead: 61000, cacheWrite: 15000 });
  const gaugeMiss = await gaugeOf("gaugeMiss", { input: 4000, cacheRead: 60000, cacheWrite: 36000, misses: 3, missTokens: 377000 });
  const gaugeCompact = await gaugeOf("gaugeCompact", { input: 3000, cacheRead: 150000, cacheWrite: 20000 });

  // The routes the crash sweep opens, and the tickets the typing checks change. Each check that
  // changes a ticket has its own, so none depends on the order the others ran in.
  const conductor = await create("Ship the greeter v2\n- Add a greet helper\n- Wire it into main\n- Update the README", { kind: "conductor" });
  const approval = await create('Install the dependencies\n/approve Bash {"command":"npm install","description":"Install dependencies"}');
  const changes = await create("Add a greet helper with an excited mode");
  const approvable = await create("Survey the greeter before the rewrite\n/agents 3");
  const messaging = await create("Warm up the mentions");
  const drafting = await create("Warm up the drafts");
  // Not started, so its branch and models can still be picked on the Details tab.
  const branchPlan = await create("Greet in the user's language", { start: false, branch: "feature/greet-emoji", baseBranch: "release/v2" });
  const code = await create("Show the greeting\n\n```ts\nexport const greeting = \"hello\";\n```");
  // A triage item for the Inbox: the dummy triager reads the [dummy:project KEY] marker.
  await api("POST", "/watchers/inject", {
    source: "jira",
    text: JSON.stringify({ key: "FOO-123", summary: "Greeter crashes on an empty name", url: "https://example.com/FOO-123", updated: "1" }),
    prompt: `If this issue is assigned to me and has actionable next steps, dispatch it to an agent in ${seeded.project.key}. [dummy:project ${seeded.project.key}]`,
  });
  await Promise.all([
    settle(code),
    until(`${conductor.key} has its children`, async () => ((await detail(conductor.key)).children.length >= 3 ? true : null), 60000, 100),
    settle(approval, (x) => !!x.pendingApproval),
    settle(changes, (x) => x.status === "review" && !x.busy && !!x.workdir),
    settle(approvable),
    settle(messaging),
    settle(drafting),
    settle(branchPlan, (x) => x.status === "planning" && !x.busy),
  ]);
  const nestedAgent = (await detail(approvable.key)).subagents!.find((s) => s.parentId)!;
  // The worktree as an agent leaves it: a commit on the branch plus uncommitted changes.
  const wd = (await detail(changes.key)).ticket.workdir!;
  mkdirSync(join(wd, "src/lib"), { recursive: true });
  writeFileSync(join(wd, "src/lib/greet.ts"), 'export function greet(name: string, excited = false) {\n  const base = "Hello, " + name;\n  return excited ? base + "!" : base;\n}\n');
  Bun.spawnSync(["git", "add", "-A"], { cwd: wd });
  Bun.spawnSync(["git", "commit", "-qm", "Add greet helper"], { cwd: wd });
  writeFileSync(join(wd, "src/app.ts"), 'import { greet } from "./lib/greet";\n\nexport function main(name = "world") {\n  console.log(greet(name, true));\n}\n');
  writeFileSync(join(wd, GREETINGS_PATH), greetings(true));

  // A project on the claude-code driver, which the daemon runs as the fake CLI (see FAKE_CLAUDE_ENV): its New session lists the agent's slash commands.
  const slashDir = join(d.scratch, "slash");
  mkdirSync(slashDir, { recursive: true });
  const slash = await api<Project>("POST", "/projects", { path: slashDir, name: "slash", key: "SLSH", defaultDriver: "claude-code" });

  // A customized review message for the prompt editor to change.
  await api("PATCH", "/settings", { prompts: { [REVIEW_PROMPT_ID]: REVIEW_PROMPT } });
  return { tasks, fileLink, gauge, gaugeMiss, gaugeCompact, conductor, approval, changes, approvable, nestedAgent, messaging, drafting, branchPlan, code, slash };
}

/** The daemon's env for the fake claude CLI, which answers the slash-command listing from SLASH_COMMANDS. */
export const FAKE_CLAUDE_ENV = {
  HARNESS_CLAUDE_BIN: resolve(import.meta.dir, "../../service/src/drivers/__fixtures__/fake-claude.ts"),
  FAKE_CLAUDE_COMMANDS: JSON.stringify(SLASH_COMMANDS),
};

export const REVIEW_PROMPT_ID = "run.review";
/** Short, so its end and its variable chips share the screen. */
export const REVIEW_PROMPT = 'Review {{ticket}} carefully.\n\nRead it with get_ticket { key: "{{key}}" }.\n\nCheck the tests first, then the diff.';

/** A compact run on the ticket's session makes its gauge read "compacting". The service's startup sweep fails runs it didn't start, so call this right before opening the ticket. */
export const startCompacting = (d: Daemon, t: Ticket) => startCompactRun(d.home, t.sessionId, `compact-${t.key}`);

/** The daemon with GET /usage answered from the usage fixture; the app pairs against `base` and talks through it. */
export function startUsageProxy(d: Daemon) {
  const report = usageFixture();
  return startDaemonProxy(() => d.base, {
    intercept: (req) => (req.method === "GET" && new URL(req.url).pathname === "/usage" ? Response.json({ data: report }) : undefined),
    // The daemon pushes its own reading (the real one, or "Sign in to Claude Code") after a claude-code run ends: it would replace the fixture.
    onUpstreamMessage: (m) => (m.includes('"usage.updated"') ? null : m),
  });
}
