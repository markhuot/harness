import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, Ticket } from "@harness/shared";
import type { DriverEvent, RunRequest } from "../drivers/types";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { HarnessError } from "./errors";
import { tokensLabel } from "./orchestrator";

type Call = Extract<DriverEvent, { type: "call" }>["call"];
const call = (input: number, cacheRead: number, cacheWrite: number, output = 50): DriverEvent => ({ type: "call", call: { input, cacheRead, cacheWrite, output } });

function setup(driver = new FakeDriver()) {
  const h = makeOrchestrator({ driver });
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, project, events };
}
type H = ReturnType<typeof setup>;

/**
 * A work run that saves its session and makes `calls`, then stops without submitting: the ticket
 * blocks, which keeps the session (a move into review or done starts the next run fresh).
 */
function scriptCalls(h: H, calls: DriverEvent[]) {
  h.driver.script = async function* (req: RunRequest) {
    if (req.kind === "work" || req.kind === "chat") {
      yield { type: "state", state: { sessionId: "s1" } };
      for (const c of calls) yield c;
      if (req.kind === "work") await req.toolContext.ops.block(req.toolContext, "waiting on you");
    }
  };
}

const ticketOf = (h: H, t: Ticket) => h.orch.ticketDetail(t.key).ticket;

async function workedTicket(h: H, calls: DriverEvent[]) {
  scriptCalls(h, calls);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
  await h.orch.idle();
  return t;
}

describe("context gauge: recording calls", () => {
  test("the ticket's context is the last call of its work run, with the first call's total as the prefix", async () => {
    const h = setup();
    const t = await workedTicket(h, [call(3, 0, 47_000), call(3, 47_000, 3_000), call(3, 50_000, 12_000, 800)]);
    expect(ticketOf(h, t).context).toMatchObject({ input: 3, cacheRead: 50_000, cacheWrite: 12_000, output: 800, prefix: 47_003, estimated: false, misses: 0, missTokens: 0 });
  });

  test("every call is kept, in order", async () => {
    const h = setup();
    const t = await workedTicket(h, [call(3, 0, 47_000), call(3, 47_000, 3_000)]);
    const calls = h.store.sessions.listCalls(t.sessionId);
    expect(calls.map((c) => [c.input, c.cacheRead, c.cacheWrite])).toEqual([[3, 0, 47_000], [3, 47_000, 3_000]]);
    expect(new Set(calls.map((c) => c.runId)).size).toBe(1);
  });

  test("a review run's calls don't move the gauge: it runs in a conversation of its own", async () => {
    const h = setup();
    const t = await workedTicket(h, [call(3, 0, 47_000)]);
    // Put the ticket in review with a saved session, then re-run its agent review, which makes a big call.
    h.store.tickets.update(t.id, { status: "review", agentReview: "approved", humanReview: "pending" });
    const saved = h.store.sessions.getContext(t.sessionId);
    expect(saved).not.toBeNull();
    h.driver.script = async function* (req) {
      yield call(1, 0, 90_000);
      if (req.kind === "review") await req.toolContext.ops.reviewDecision(req.toolContext, "approve", "LGTM");
    };
    h.orch.rerunAgentReview(t.key);
    await h.orch.idle();
    expect(h.store.sessions.listCalls(t.sessionId).at(-1)).toMatchObject({ cacheWrite: 90_000 });
    expect(h.store.sessions.getContext(t.sessionId)).toEqual(saved);
  });

  test("the gauge updates live: each call re-broadcasts the ticket", async () => {
    const h = setup();
    const seen: number[] = [];
    h.bus.on((e) => {
      if (e.kind === "ticket.upserted" && e.ticket.context) seen.push(e.ticket.context.cacheWrite);
    });
    await workedTicket(h, [call(3, 0, 47_000), call(3, 47_000, 3_000)]);
    expect(seen).toContain(47_000);
    expect(seen).toContain(3_000);
    expect(seen.indexOf(47_000)).toBeLessThan(seen.indexOf(3_000));
  });

  test("cache misses are counted per session and shown on the ticket; a hit that writes a lot isn't one", async () => {
    const h = setup();
    const t = await workedTicket(h, [call(3, 0, 50_000), call(3, 50_000, 40_000), call(3, 20_000, 150_000), call(3, 170_000, 500)]);
    expect(ticketOf(h, t).context).toMatchObject({ misses: 1, missTokens: 150_000 });
  });

  test("a message resumes the same session: the new run's first call isn't a miss, and misses keep adding up", async () => {
    const h = setup();
    const t = await workedTicket(h, [call(3, 0, 50_000), call(3, 20_000, 80_000)]);
    expect(ticketOf(h, t).status).toBe("blocked");
    expect(ticketOf(h, t).context!.misses).toBe(1);
    // The chat run re-reads the conversation from a cold cache (first call: not a miss), then misses again mid-run.
    scriptCalls(h, [call(3, 0, 130_000), call(3, 130_000, 2_000), call(3, 10_000, 125_000)]);
    await h.orch.sendMessage(t.key, "please continue");
    await h.orch.idle();
    expect(ticketOf(h, t).context).toMatchObject({ misses: 2, missTokens: 80_000 + 125_000, prefix: 50_003 });
  });

  test("an estimate (a driver that reports no tokens) is marked estimated and never counts misses", async () => {
    const h = setup();
    const t = await workedTicket(h, [
      { type: "call", call: { input: 60_000, cacheRead: 0, cacheWrite: 0, output: 0, estimated: true } },
      { type: "call", call: { input: 140_000, cacheRead: 0, cacheWrite: 0, output: 0, estimated: true } },
    ]);
    expect(ticketOf(h, t).context).toMatchObject({ estimated: true, input: 140_000, misses: 0 });
  });

  test("a call from a run that started before the session was cleared doesn't touch the new session's gauge", async () => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.driver.script = async function* (req) {
      if (req.kind !== "work") return;
      yield { type: "state", state: { sessionId: "s1" } };
      yield call(3, 0, 40_000);
      await gate;
      yield call(3, 40_000, 5_000);
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    while (!ticketOf(h, t).context) await Bun.sleep(2);
    // What a column move does, with the run still going.
    (h.orch as unknown as { newSession(id: string): void }).newSession(t.sessionId);
    release();
    await h.orch.idle();
    expect(h.store.sessions.listCalls(t.sessionId)).toHaveLength(2); // the log has both
    expect(ticketOf(h, t).context).toBeNull(); // the fresh session has none
  });

  test("moving to review starts the next run fresh, and the gauge with it", async () => {
    const h = setup();
    h.driver.script = async function* (req) {
      if (req.kind === "work") {
        yield { type: "state", state: { sessionId: "s1" } };
        yield call(3, 0, 47_000);
        await req.toolContext.ops.submitForReview(req.toolContext, "done", true);
      } else if (req.kind === "review") await req.toolContext.ops.reviewDecision(req.toolContext, "approve", "LGTM");
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    expect(ticketOf(h, t).status).toBe("review");
    expect(ticketOf(h, t).context).toBeNull();
    expect(h.store.sessions.getDriverState(t.sessionId)).toBeNull();
    // The call itself is still in the log.
    expect(h.store.sessions.listCalls(t.sessionId)).toHaveLength(1);
  });
});

describe("session actions", () => {
  async function idleTicket(h: H) {
    const t = await workedTicket(h, [call(3, 0, 47_000), call(3, 47_000, 3_000), call(3, 50_000, 12_000)]);
    // The run stopped without submitting, so the ticket is blocked with its session saved.
    expect(ticketOf(h, t).status).toBe("blocked");
    return t;
  }

  test("New session drops the saved state and the gauge, and says so in Activity", async () => {
    const h = setup();
    const t = await idleTicket(h);
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ sessionId: "s1" });
    const after = await h.orch.sessionAction(t.key, { action: "new" });
    expect(after.context).toBeNull();
    expect(h.store.sessions.getDriverState(t.sessionId)).toBeNull();
    expect(h.orch.activity(t.key).at(-1)).toMatchObject({ kind: "system", author: "human", body: "Session cleared (62k tokens); the next run starts fresh" });
  });

  test("the next run after New session gets no saved state", async () => {
    const h = setup();
    const t = await idleTicket(h);
    await h.orch.sessionAction(t.key, { action: "new" });
    scriptCalls(h, [call(3, 0, 50_000)]);
    await h.orch.sendMessage(t.key, "again");
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "chat").at(-1)!.state).toBeNull();
    expect(ticketOf(h, t).context).toMatchObject({ cacheWrite: 50_000, misses: 0, prefix: 50_003 });
  });

  test("New session with nothing saved changes nothing", async () => {
    const h = setup();
    const t = await idleTicket(h);
    await h.orch.sessionAction(t.key, { action: "new" });
    const before = h.orch.activity(t.key).length;
    await h.orch.sessionAction(t.key, { action: "new" });
    expect(h.orch.activity(t.key)).toHaveLength(before);
  });

  test("a run going refuses both actions with 409 and leaves the session alone", async () => {
    const h = setup();
    const t = await idleTicket(h);
    h.driver.script = async function* (req) {
      if (req.kind === "chat") await new Promise<void>((r) => req.signal.addEventListener("abort", () => r(), { once: true }));
    };
    await h.orch.sendMessage(t.key, "hold on");
    for (const action of ["new", "compact"] as const) {
      const err = await h.orch.sessionAction(t.key, { action }).catch((e) => e);
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).status).toBe(409);
    }
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ sessionId: "s1" });
    await h.orch.cancelTicket(t.key);
    await h.orch.idle();
  });

  test("an unknown action is a 400", async () => {
    const h = setup();
    const t = await idleTicket(h);
    const err = await h.orch.sessionAction(t.key, { action: "fork" } as never).catch((e) => e);
    expect((err as HarnessError).status).toBe(400);
  });

  test("Compact runs the driver's compact, keeps the state, and shows the new size and an Activity line", async () => {
    const h = setup();
    const t = await idleTicket(h);
    h.driver.compactResult = { before: 482_000, after: 61_000 };
    const started = await h.orch.sessionAction(t.key, { action: "compact" });
    expect(started.compacting).toBe(true);
    expect(started.busy).toBe(true);
    await h.orch.idle();
    const cur = ticketOf(h, t);
    expect(cur.compacting).toBe(false);
    expect(cur.status).toBe("blocked"); // a compact run doesn't move the card
    expect(cur.context).toMatchObject({ cacheWrite: 61_000, misses: 0, prefix: 47_003 });
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ sessionId: "s1" });
    expect(h.driver.compactRequests).toHaveLength(1);
    expect(h.driver.compactRequests[0]).toMatchObject({ kind: "compact", state: { sessionId: "s1" } });
    expect(h.orch.activity(t.key).at(-1)).toMatchObject({ kind: "system", body: "Session compacted: 482k → 61k tokens" });
    expect(h.store.runs.listBySession(t.sessionId).at(-1)).toMatchObject({ kind: "compact", status: "succeeded" });
  });

  test("while compacting, messages and ticket actions are refused with 409, and they work again after", async () => {
    const h = setup();
    const t = await idleTicket(h);
    let release!: () => void;
    h.driver.compactGate = new Promise<void>((r) => (release = r));
    await h.orch.sessionAction(t.key, { action: "compact" });
    const refused = await Promise.all([
      h.orch.sendMessage(t.key, "hello").catch((e) => e),
      Promise.resolve().then(() => h.orch.startTicket(t.key)),
    ].map((p) => Promise.resolve(p).catch((e) => e)));
    for (const err of refused) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).status).toBe(409);
      expect((err as HarnessError).message).toContain("The session is compacting");
    }
    expect(ticketOf(h, t).compacting).toBe(true);
    release();
    await h.orch.idle();
    expect(ticketOf(h, t).compacting).toBe(false);
    await h.orch.sendMessage(t.key, "hello"); // accepted now
    await h.orch.idle();
  });

  test("cancelling a compact leaves the saved session and gauge as they were", async () => {
    const h = setup();
    const t = await idleTicket(h);
    const before = ticketOf(h, t).context;
    h.driver.compactGate = new Promise<void>(() => {}); // never finishes
    await h.orch.sessionAction(t.key, { action: "compact" });
    await h.orch.cancelTicket(t.key);
    await h.orch.idle();
    const cur = ticketOf(h, t);
    expect(cur.compacting).toBe(false);
    expect(cur.context).toEqual(before);
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ sessionId: "s1" });
    expect(h.store.runs.listBySession(t.sessionId).at(-1)).toMatchObject({ kind: "compact", status: "cancelled" });
  });

  test("a failed compact says why in Activity and leaves the gauge alone", async () => {
    const h = setup();
    const t = await idleTicket(h);
    const before = ticketOf(h, t).context;
    h.driver.compactError = "No conversation found";
    await h.orch.sessionAction(t.key, { action: "compact" });
    await h.orch.idle();
    expect(ticketOf(h, t).context).toEqual(before);
    expect(h.orch.activity(t.key).at(-1)).toMatchObject({ kind: "failed", body: "Compacting the session failed: No conversation found" });
  });

  test("Compact needs a saved session and a driver that can", async () => {
    const h = setup();
    const empty = await idleTicket(h);
    await h.orch.sessionAction(empty.key, { action: "new" });
    expect(((await h.orch.sessionAction(empty.key, { action: "compact" }).catch((e) => e)) as HarnessError).status).toBe(409);

    const t = await idleTicket(h);
    h.driver.sessionActions = { compact: false, newSession: true };
    expect(((await h.orch.sessionAction(t.key, { action: "compact" }).catch((e) => e)) as HarnessError).status).toBe(400);
    h.driver.sessionActions = { compact: true, newSession: false };
    expect(((await h.orch.sessionAction(t.key, { action: "new" }).catch((e) => e)) as HarnessError).status).toBe(400);
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ sessionId: "s1" });
  });
});

describe("driver capabilities", () => {
  test("the driver list carries what each driver can do with a session", async () => {
    const compacting = new FakeDriver("a");
    const plain = new FakeDriver("b");
    plain.sessionActions = { compact: false, newSession: true };
    plain.reportsContextUsage = false;
    const none = new FakeDriver("c");
    none.sessionActions = undefined;
    const h = makeOrchestrator({ driver: compacting, drivers: [compacting, plain, none] });
    const infos = Object.fromEntries((await h.orch.driverInfos()).map((i) => [i.id, i]));
    expect(infos.a).toMatchObject({ sessionActions: { compact: true, newSession: true }, reportsContextUsage: true });
    expect(infos.b).toMatchObject({ sessionActions: { compact: false, newSession: true }, reportsContextUsage: false });
    expect(infos.c!.sessionActions).toBeUndefined();
  });
});

describe("contextGaugeLimit setting", () => {
  test("defaults to 250k, saves, and refuses what isn't 10k–2M tokens", () => {
    const h = setup();
    expect(h.orch.publicSettings().contextGaugeLimit).toBe(250_000);
    expect(h.orch.updateSettings({ contextGaugeLimit: 400_000 }).contextGaugeLimit).toBe(400_000);
    for (const bad of [9_999, 2_000_001, 1.5, "250k", null]) {
      expect(() => h.orch.updateSettings({ contextGaugeLimit: bad as never })).toThrow(/contextGaugeLimit/);
    }
    expect(h.orch.publicSettings().contextGaugeLimit).toBe(400_000);
  });
});

describe("tokensLabel", () => {
  test("writes counts the way the gauge does", () => {
    expect([tokensLabel(850), tokensLabel(1_000), tokensLabel(61_400), tokensLabel(482_000), tokensLabel(1_200_000), tokensLabel(2_000_000)]).toEqual(["850", "1k", "61k", "482k", "1.2M", "2M"]);
  });
});
