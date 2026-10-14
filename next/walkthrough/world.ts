// What the iPhone walkthrough adds to dev-sim's GREET world: tickets for the Agents & tasks filter,
// a spec linking into a file, and the context gauge, plus the plan-usage proxy. They are created
// after GREET-1…6, so the keys the other screens use don't move.
import { until } from "@harness/shared/testing/daemon";
import { setSessionContext, startCompactRun } from "@harness/shared/testing/seed";
import type { Ticket, TicketDetail } from "@harness/shared";
import { startDaemonProxy } from "@harness/shared/testing/proxy";
import { GREETINGS_PATH, GREETING_FOR, greetings, usageFixture } from "../../ios/Tools/fixtures";
import type { Daemon, Seeded } from "../../ios/Tools/dev-sim";

/** The file the linked ticket's spec points into; pass it to dev-sim's `seed` so it's committed on main. */
export const WORLD_FILES = { [GREETINGS_PATH]: greetings(false) };

export type World = { tasks: Ticket; fileLink: Ticket; gauge: Ticket; gaugeMiss: Ticket; gaugeCompact: Ticket };

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
  return { tasks, fileLink, gauge, gaugeMiss, gaugeCompact };
}

/** A compact run on the ticket's session makes its gauge read "compacting". The service's startup sweep fails runs it didn't start, so call this right before opening the ticket. */
export const startCompacting = (d: Daemon, t: Ticket) => startCompactRun(d.home, t.sessionId, `compact-${t.key}`);

/** The daemon with GET /usage answered from the usage fixture; the app pairs against `base` and talks through it. */
export function startUsageProxy(d: Daemon) {
  const report = usageFixture();
  return startDaemonProxy(() => d.base, { intercept: (req) => (req.method === "GET" && new URL(req.url).pathname === "/usage" ? Response.json({ data: report }) : undefined) });
}
