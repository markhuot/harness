import { afterEach, expect, test } from "bun:test";
import type { Ticket } from "@harness/shared";
import { gate, replyScript, toolCall, type Step } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const submit = (note = "Added the button; tests pass") => toolCall("submit_for_review", { note, spec_is_up_to_date: true });
/** What a reviewing agent does: the driver saves its conversation as it goes, then the verdict. */
const decide = (decision: "approve" | "request_changes", notes: string): Step[] => [{ type: "state", state: { reviewer: true } }, ...toolCall("review_decision", { decision, notes })];
const activity = (h: ReturnType<typeof makeOrchestrator>, t: Ticket) => h.store.activity.listBySession(t.sessionId).map((a) => `${a.kind}/${a.author}: ${a.body}`);

test("the agent submitting moves the ticket to review and an independent review run follows", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script([...submit()], [...decide("approve", "Approved, nothing to fix.")]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "review"]);
  // A review judges the work cold: it never inherits the work's conversation.
  expect(h.driver.requests[1]!.state).toBeNull();
  // ...and its own conversation isn't kept for a later run to resume.
  expect(h.store.sessions.getDriverState(t.sessionId)).toBeNull();
  expect(h.ticket(t.key)).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
  expect(activity(h, t)).toEqual(expect.arrayContaining(["submitted/agent: Added the button; tests pass", "review_approved/agent: Approved, nothing to fix."]));
});

test("a review that requests changes sends the notes back to a new work run, and a second submit goes to review again", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(submit(), decide("request_changes", "Changes requested: the label is wrong.\nfile.ts:3 says Sumbit."), [...submit("Fixed the label")], decide("approve", "Approved."));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "review", "work", "review"]);
  expect(h.driver.requests[2]!.prompt).toContain("Sumbit");
  expect(h.ticket(t.key)).toMatchObject({ status: "review", agentReview: "approved" });
  expect(activity(h, t)).toContain("changes_requested/agent: Changes requested: the label is wrong.");
});

test("submitting without saying the spec is up to date is refused with what to do, and nothing moves", async () => {
  const h = makeOrchestrator({ tools: undefined });
  let result = "";
  h.driver.script(
    toolCall("submit_for_review", { note: "done" }, (r) => {
      result = JSON.stringify(r);
    }),
  );
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  expect(result).toContain("isError");
  expect(result.toLowerCase()).toContain("spec");
  // The run ended without a submit, so the service moved it to review itself: no agent note.
  expect(activity(h, t).some((a) => a.startsWith("submitted/agent"))).toBe(false);
});

test("the agent blocking asks a question and stops; the human's answer goes to a chat run, and the agent unblocks to resume the work", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(toolCall("block", { question: "Which colour should it be?" }), toolCall("unblock", { note: "Blue, as answered" }));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", blockedReason: "Which colour should it be?" });
  await h.orch.sendMessage(t.key, "Blue.");
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "chat"]);
  expect(h.driver.requests[1]!.prompt).toContain("Blue.");
  expect(h.driver.requests[1]!.prompt).toContain("Which colour should it be?");
  expect(activity(h, t)).toEqual(expect.arrayContaining([expect.stringContaining("blocked/agent: Which colour"), expect.stringContaining("unblocked/")]));
  expect(h.ticket(t.key).blockedReason).toBeNull();
});

test("a human's approval with the last review done runs Complete with their instructions and lands the ticket in done", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(submit(), replyScript("merged"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  // With the agent review skipped, the human's approval is the last thing the ticket waits on.
  h.orch.humanReview(t.key, { decision: "approve", notes: "Looks good", instructions: "merge it" });
  expect(h.ticket(t.key).humanReview).toBe("approved");
  await h.settle();
  const done = h.ticket(t.key);
  expect(done.status).toBe("done");
  expect(done.completedAt).toBe(h.clock());
  expect(h.driver.requests.at(-1)).toMatchObject({ kind: "complete" });
  expect(h.driver.requests.at(-1)!.prompt).toContain("merge it");
});

test("a human can request changes on a ticket in review: it goes back to work with their words", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(submit(), replyScript("fixed"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  h.orch.humanReview(t.key, { decision: "request_changes", notes: "Make it bigger" });
  await h.settle();
  expect(h.driver.requests[1]).toMatchObject({ kind: "work" });
  expect(h.driver.requests[1]!.prompt).toContain("Make it bigger");
});

test("humanReview only works on a ticket in review", async () => {
  const h = makeOrchestrator();
  const hold = gate();
  h.driver.script([{ wait: hold }]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.driver.runStarted();
  expect(() => h.orch.humanReview(t.key, { decision: "approve" })).toThrow(/not in review/);
});

test("the skip switches decide which reviews happen: skipping both lands the ticket without a review run", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(submit());
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true, skipHumanReview: true });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).not.toContain("review");
  expect(h.ticket(t.key)).toMatchObject({ agentReview: "skipped" });
});
