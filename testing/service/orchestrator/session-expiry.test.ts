import { afterEach, expect, test } from "bun:test";
import { bigReplyScript, FakeDriver, gate, replyScript } from "../fake-driver";
import { SESSION_EXPIRY_MIN_TOKENS } from "../../../service/src/orchestrator/session-expiry";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const HOUR = 3_600_000;
const HANDOFF = "We're starting a new session because the previous one went idle";

/** Just the handoff block of a run's context: the rest of it mentions sub-agents elsewhere. */
const handoff = (ctx: string | undefined) => (ctx ?? "").split("## New session")[1]?.split("\n## ")[0] ?? "";

const rig = (driver = new FakeDriver({ cacheTtlMs: HOUR, subagentTool: "the `Agent` tool" })) => makeOrchestrator({ driver });

/**
 * A ticket with a big saved conversation. The work run's submit moves the ticket to review, which
 * starts a new session, so the conversation is the one a message in review builds.
 */
async function bigSession(h = rig(), prefix = 150_000) {
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", skipAgentReview: true });
  await h.settle();
  h.driver.script(bigReplyScript("warm", prefix));
  await h.orch.sendMessage(t.key, "warm up");
  await h.settle();
  return { h, t, sessionId: h.ticket(t.key).sessionId };
}

const later = async (h: ReturnType<typeof rig>, key: string, text: string, ms: number) => {
  h.clock.advance(ms);
  await h.orch.sendMessage(key, text);
  await h.settle();
};

test("a big session idle past the cache starts fresh: state and gauge cleared, a new session announced, the handoff points at the old transcript", async () => {
  const { h, t, sessionId } = await bigSession();
  expect(h.store.sessions.getContext(sessionId)).not.toBeNull();
  await later(h, t.key, "back again", HOUR + 60_000);
  const req = h.driver.requests.at(-1)!;
  expect(req.state).toBeNull();
  expect(req.runContext).toContain(HANDOFF);
  expect(handoff(req.runContext)).toContain("sub-agent");
  expect(handoff(req.runContext)).toContain("include_transcript");
  expect(h.store.activity.listBySession(sessionId).some((e) => e.body === "New session: the previous one was idle for 1h 1m, past the 1h cache.")).toBe(true);
  // The run saved its own conversation under the new session, so the next one resumes it.
  await later(h, t.key, "and again", 60_000);
  expect(h.driver.requests.at(-1)!.state).toMatchObject({ sessionId: "fake-session" });
  expect(h.driver.requests.at(-1)!.runContext ?? "").not.toContain(HANDOFF);
});

test("inside the TTL, or below 100k tokens, the run resumes with no handoff", async () => {
  const warm = await bigSession();
  await later(warm.h, warm.t.key, "soon", HOUR);
  expect(warm.h.driver.requests.at(-1)!.state).not.toBeNull();
  expect(warm.h.driver.requests.at(-1)!.runContext ?? "").not.toContain(HANDOFF);
  const small = await bigSession(rig(), SESSION_EXPIRY_MIN_TOKENS - 1);
  await later(small.h, small.t.key, "much later", 10 * HOUR);
  expect(small.h.driver.requests.at(-1)!.state).not.toBeNull();
});

test("a driver that declares no cache TTL never expires a session", async () => {
  const { h, t } = await bigSession(rig(new FakeDriver()));
  await later(h, t.key, "much later", 100 * HOUR);
  expect(h.driver.requests.at(-1)!.state).not.toBeNull();
});

test("a first run, and a human's New session, get no handoff", async () => {
  const { h, t } = await bigSession();
  expect(h.driver.requests.at(-1)!.runContext ?? "").not.toContain(HANDOFF);
  await h.orch.sessionAction(t.key, { action: "new" });
  await later(h, t.key, "fresh start", 5 * HOUR);
  expect(h.driver.requests.at(-1)!.state).toBeNull();
  expect(h.driver.requests.at(-1)!.runContext ?? "").not.toContain(HANDOFF);
});

test("a review run's calls neither refresh the conversation's cache nor shrink its measured size", async () => {
  const { h, t, sessionId } = await bigSession();
  h.clock.advance(2 * HOUR);
  const run = h.store.runs.create({ sessionId, kind: "review", driver: "fake", prompt: "review", attachments: [] });
  h.store.sessions.addCall(sessionId, run.id, { input: 1, cacheRead: 0, cacheWrite: 10, output: 1 }, h.clock());
  await later(h, t.key, "back", 60_000);
  expect(h.driver.requests.at(-1)!.state).toBeNull();
});

test("the chief of staff's handoff names no sub-agent and reads its memory, not notes", async () => {
  const h = rig();
  const cos = h.orch.openCos("all");
  h.driver.script(bigReplyScript("hello"));
  await h.orch.sendMessage(cos.key, "hi");
  await h.settle();
  await later(h, cos.key, "hi again", 2 * HOUR);
  const ctx = handoff(h.driver.requests.at(-1)!.runContext);
  expect(ctx).toContain(HANDOFF);
  expect(ctx).not.toContain("sub-agent");
  expect(ctx).toContain("your memory");
  expect(ctx).toContain("include_transcript");
});

test("a driver without sub-agents reads the old conversation itself", async () => {
  const { h, t } = await bigSession(rig(new FakeDriver({ cacheTtlMs: HOUR })));
  await later(h, t.key, "back", 2 * HOUR);
  const ctx = handoff(h.driver.requests.at(-1)!.runContext);
  expect(ctx).toContain(HANDOFF);
  expect(ctx).not.toContain("sub-agent");
  expect(ctx).toContain("include_transcript");
});

test("a session whose other run is still going is left alone, and a burst rotates once", async () => {
  const { h, t, sessionId } = await bigSession();
  const hold = gate();
  h.driver.script([{ type: "state", state: { sessionId: "second" } }, { wait: hold }, ...replyScript("second", { sessionId: "second" }).slice(1)]);
  h.clock.advance(2 * HOUR);
  await h.orch.sendMessage(t.key, "one");
  await h.driver.runStarted(3);
  // A second message steers or queues behind the running run; either way the session isn't rotated under it.
  await h.orch.sendMessage(t.key, "two");
  hold.open();
  await h.settle();
  const starts = h.store.activity.listBySession(sessionId).filter((e) => e.body.startsWith("New session:"));
  expect(starts).toHaveLength(1);
  expect(h.driver.requests.filter((r) => (r.runContext ?? "").includes(HANDOFF))).toHaveLength(1);
});
