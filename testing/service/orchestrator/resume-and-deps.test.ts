import { afterEach, expect, test } from "bun:test";
import { RESUME_GRACE_MS } from "../../../service/src/orchestrator/usage-limit";
import { failScript, replyScript, toolCall } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const limitAt = (ms: number) => `Claude AI usage limit reached|${Math.floor(ms / 1000)}`;

test("a run that hits a usage limit blocks the ticket with a restart time: the reset plus five minutes", async () => {
  const h = makeOrchestrator();
  const reset = h.clock() + 3_600_000;
  h.driver.script(failScript(limitAt(reset)));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", resumeAt: Math.floor(reset / 1000) * 1000 + RESUME_GRACE_MS });
  expect(h.store.activity.listBySession(t.sessionId).map((a) => a.kind)).toContain("failed");
});

test("a limit with no parseable reset time blocks without scheduling a restart", async () => {
  const h = makeOrchestrator();
  h.driver.script(failScript("You've hit your individual spend limit"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", resumeAt: null });
});

test("a restart that came due while the service was down runs at start; one not due yet waits", async () => {
  const h = makeOrchestrator();
  const reset = h.clock() + 3_600_000;
  h.driver.script(failScript(limitAt(reset)), replyScript("back at it"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", skipAgentReview: true });
  await h.settle();
  const resumeAt = h.ticket(t.key).resumeAt!;
  h.clock.set(resumeAt - 1);
  h.orch.start();
  await h.settle();
  expect(h.driver.requests).toHaveLength(1);
  expect(h.ticket(t.key).status).toBe("blocked");
  h.clock.set(resumeAt);
  h.orch.start();
  await h.settle();
  expect(h.driver.requests).toHaveLength(2);
  expect(h.driver.requests[1]!.kind).toBe("work");
  expect(h.ticket(t.key)).toMatchObject({ status: "review", resumeAt: null, blockedReason: null });
  expect(h.store.transcript.list(t.sessionId).some((e) => e.content.type === "status" && e.content.text.includes("usage limit"))).toBe(true);
});

test("answering a usage-limit block with a chat message doesn't cancel the scheduled restart", async () => {
  const h = makeOrchestrator();
  h.driver.script(failScript(limitAt(h.clock() + 3_600_000)), replyScript("chat answer"), replyScript("restarted work"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", skipAgentReview: true });
  await h.settle();
  const resumeAt = h.ticket(t.key).resumeAt!;
  await h.orch.sendMessage(t.key, "how long will it take?");
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", resumeAt });
  h.clock.set(resumeAt);
  h.orch.start();
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "chat", "work"]);
});

const land = () => toolCall("submit_for_review", { note: "done", spec_is_up_to_date: true });

test("a ticket that depends on another waits, and starts by itself when its dependency is done", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(land(), replyScript("completed"), replyScript("B's work"));
  const a = await h.orch.createTicket({ projectId: h.project.id, spec: "A", skipAgentReview: true, skipHumanReview: true });
  const b = await h.orch.createTicket({ projectId: h.project.id, spec: "B", dependsOn: [a.key], skipAgentReview: true });
  await h.settle();
  // B's work comes only after A's completion run.
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "complete", "work"]);
  expect(h.driver.requests[2]!.prompt).toContain(`Begin work on ${b.key}`);
  expect(h.ticket(a.key).status).toBe("done");
  expect(h.ticket(b.key).status).toBe("review");
});

test("while its dependency is unfinished the waiting ticket has no run and says what it waits on", async () => {
  const h = makeOrchestrator();
  const a = await h.orch.createTicket({ projectId: h.project.id, spec: "A", start: false });
  const b = await h.orch.createTicket({ projectId: h.project.id, spec: "B", dependsOn: [a.key] });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["plan"]);
  expect(h.store.runs.listBySession(b.sessionId)).toEqual([]);
  const status = h.store.transcript.list(b.sessionId).filter((e) => e.content.type === "status").map((e) => (e.content as { text: string }).text);
  expect(status.some((s) => s.includes(a.key))).toBe(true);
});

test("a dependency on a ticket that doesn't exist is refused when the ticket is created", async () => {
  const h = makeOrchestrator();
  await expect(h.orch.createTicket({ projectId: h.project.id, spec: "B", dependsOn: ["GONE-9"] })).rejects.toThrow(/Unknown dependency: GONE-9/);
  expect(h.store.tickets.list()).toEqual([]);
});
