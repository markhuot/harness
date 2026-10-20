import { afterEach, expect, test } from "bun:test";
import { gate, replyScript, toolCall, type Step } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const submit = () => toolCall("submit_for_review", { note: "done", spec_is_up_to_date: true });
const decide = (decision: "approve" | "request_changes", notes: string): Step[] => [{ type: "state", state: { reviewer: true } }, ...toolCall("review_decision", { decision, notes })];

test("cancelling the auto start of a ticket queued behind a dependency keeps it in planning when the dependency finishes", async () => {
  const h = makeOrchestrator();
  const a = await h.orch.createTicket({ projectId: h.project.id, spec: "A", start: false });
  const b = await h.orch.createTicket({ projectId: h.project.id, spec: "B", dependsOn: [a.key] });
  await h.settle();
  expect(h.ticket(b.key).autoStart).toBe(true);

  h.orch.cancelStart(b.key);
  expect(h.ticket(b.key)).toMatchObject({ status: "planning", autoStart: false });

  await h.orch.completeTicket(a.key, { skipAgent: true });
  await h.settle();
  expect(h.ticket(a.key).status).toBe("done");
  expect(h.ticket(b.key).status).toBe("planning");
  expect(h.store.runs.listBySession(b.sessionId)).toEqual([]);

  // Start is the human's again, and runs now that nothing is open.
  h.driver.script(replyScript("B's work"));
  await h.orch.startTicket(b.key);
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toContain("work");
  expect(h.ticket(b.key).status).not.toBe("planning");
});

test("cancelling an approved plan leaves the plan run going and the ticket in planning when it ends", async () => {
  const h = makeOrchestrator();
  const hold = gate();
  h.driver.script([{ wait: hold }, ...replyScript("planned")]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Plan me", start: false });
  await h.driver.runStarted();
  await h.orch.startTicket(t.key);
  expect(h.ticket(t.key).startAfterPlan).toBe(true);

  h.orch.cancelStart(t.key);
  expect(h.ticket(t.key)).toMatchObject({ status: "planning", startAfterPlan: false, busy: true });

  hold.open();
  await h.settle();
  expect(h.ticket(t.key).status).toBe("planning");
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["plan"]);
});

test("cancelStart is refused outside planning and when nothing starts by itself", async () => {
  const h = makeOrchestrator();
  const idle = await h.orch.createTicket({ projectId: h.project.id, spec: "Idle", start: false });
  await h.settle();
  expect(() => h.orch.cancelStart(idle.key)).toThrow(/not set to start automatically/);

  const hold = gate();
  h.driver.script([{ wait: hold }]);
  const working = await h.orch.createTicket({ projectId: h.project.id, spec: "Working", skipAgentReview: true });
  await h.driver.runStarted();
  expect(() => h.orch.cancelStart(working.key)).toThrow(/in in_progress/);
});

test("withdrawing the approval in review while the agent review runs makes the ticket wait for a human again", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const hold = gate();
  h.driver.script(submit(), [{ wait: hold }, ...decide("approve", "Fine.")]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
  await h.driver.runStarted(2);
  h.orch.humanReview(t.key, { decision: "approve", instructions: "merge it" });
  expect(h.ticket(t.key)).toMatchObject({ status: "review", humanReview: "approved", completionInstructions: "merge it" });

  h.orch.withdrawApproval(t.key);
  expect(h.ticket(t.key)).toMatchObject({ humanReview: "pending", completionInstructions: null });

  hold.open();
  await h.settle();
  // The agent review passing no longer lands it: nobody approved.
  expect(h.ticket(t.key)).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "review"]);
});

test("withdrawing the standing skip while the agent works asks for a human review at submit", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const hold = gate();
  h.driver.script([{ wait: hold }, ...submit()]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true, skipHumanReview: true });
  await h.driver.runStarted();

  h.orch.withdrawApproval(t.key);
  expect(h.ticket(t.key).skipHumanReview).toBe(false);

  hold.open();
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "review", humanReview: "pending" });
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work"]);
});

test("withdrawApproval is refused with nothing approved, and once the complete run has started", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const hold = gate();
  h.driver.script(submit(), [{ wait: hold }]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  expect(() => h.orch.withdrawApproval(t.key)).toThrow(/no human review approval/);

  h.orch.humanReview(t.key, { decision: "approve" });
  await h.driver.runStarted(2);
  expect(h.driver.requests.at(-1)).toMatchObject({ kind: "complete" });
  expect(() => h.orch.withdrawApproval(t.key)).toThrow(/is completing/);
  expect(h.ticket(t.key).humanReview).toBe("approved");
  hold.open();
});
