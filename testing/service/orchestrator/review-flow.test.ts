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

// ---- A completion run that blocks resumes the completion when unblocked (DESIGN.md "Completion") ----

const ASK = "Delete the untracked shots/ directory?";

/** A ticket whose human-approved completion run blocked with ASK; `after` scripts what runs next. */
async function blockedCompletion(...after: Step[][]) {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(submit(), toolCall("block", { question: ASK }), ...after);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  h.orch.humanReview(t.key, { decision: "approve", notes: "Looks good", instructions: "merge it" });
  await h.settle();
  return { h, t };
}
const movesTo = (h: ReturnType<typeof makeOrchestrator>, t: Ticket, to: string) => h.store.activity.listBySession(t.sessionId).filter((a) => a.kind === "moved" && a.meta.to === to).length;

test("a completion run's block keeps both approvals and records that a completion blocked", async () => {
  const { h, t } = await blockedCompletion();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", blockedReason: ASK, blockedRunKind: "complete", agentReview: "skipped", humanReview: "approved" });
});

test("a work run's block still records no completion, and unblocking it goes back through work with both reviews pending", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(toolCall("block", { question: "Which colour?" }), replyScript("blue it is"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", blockedRunKind: null });
  await h.orch.unblockTicket(t.key, { notes: "Blue" });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "work"]);
  expect(h.ticket(t.key)).toMatchObject({ blockedRunKind: null, humanReview: "pending" });
});

test("the human unblocking a completion's block starts a new completion run with the question and the answer, never passing through in progress", async () => {
  const { h, t } = await blockedCompletion(replyScript("cleaned up and merged"));
  const toProgress = movesTo(h, t, "in_progress");
  const out = await h.orch.unblockTicket(t.key, { notes: "Yes, delete it" });
  expect(out).toMatchObject({ status: "review", blockedReason: null, blockedRunKind: null, humanReview: "approved" });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "complete", "complete"]);
  const prompt = h.driver.requests[2]!.prompt;
  expect(prompt).toContain(ASK);
  expect(prompt).toContain("Yes, delete it");
  expect(prompt).toContain("merge it"); // the stored completion instructions still apply
  expect(h.driver.requests[2]!.state).toBeNull();
  expect(h.ticket(t.key).status).toBe("done");
  expect(movesTo(h, t, "in_progress")).toBe(toProgress);
});

test("a chat that answers a completion's question and unblocks resumes the completion when the chat ends", async () => {
  const { h, t } = await blockedCompletion(toolCall("unblock", { note: "Told to delete" }), replyScript("merged"));
  await h.orch.sendMessage(t.key, "Yes, delete shots/");
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "complete", "chat", "complete"]);
  const prompt = h.driver.requests[3]!.prompt;
  expect(prompt).toContain(ASK);
  expect(prompt).toContain("Yes, delete shots/");
  expect(h.ticket(t.key)).toMatchObject({ status: "done", humanReview: "approved" });
});

test("a chat that only answers leaves a completion's block open", async () => {
  const { h, t } = await blockedCompletion(replyScript("it holds untracked screenshots"));
  await h.orch.sendMessage(t.key, "What is in it?");
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", blockedRunKind: "complete", humanReview: "approved" });
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "complete", "chat"]);
});

test("a branch that moved while blocked is not completed: unblocking goes back to work with both reviews pending", async () => {
  const { h, t } = await blockedCompletion(replyScript("amended the work"));
  h.store.tickets.update(t.id, { blockedHead: "0000000000000000000000000000000000000000" });
  const out = await h.orch.unblockTicket(t.key, { notes: "Go ahead" });
  expect(out).toMatchObject({ status: "in_progress", blockedRunKind: null, blockedHead: null, humanReview: "pending", agentReview: "pending" });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "complete", "work"]);
});

test("the agent chatting after a completion's question can send the ticket back to in progress instead: approvals reset, no completion", async () => {
  const { h, t } = await blockedCompletion(toolCall("resume_work", { note: "The answer changes the work" }), submit("Changed it"));
  await h.orch.sendMessage(t.key, "No, move it into docs/ instead");
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "complete", "chat"]);
  expect(h.ticket(t.key)).toMatchObject({ status: "review", blockedRunKind: null, humanReview: "pending" });
});

test("a resumed completion run can send the ticket back to in progress: a work run follows when it ends", async () => {
  const { h, t } = await blockedCompletion(toolCall("resume_work", { note: "Needs another change" }), replyScript("changed"));
  await h.orch.unblockTicket(t.key, { notes: "Actually move it to docs/" });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "complete", "complete", "work"]);
  expect(h.ticket(t.key)).toMatchObject({ status: "review", humanReview: "pending" });
});

test("leaving Blocked any other way clears the completion marker", async () => {
  const { h, t } = await blockedCompletion();
  const moved = await h.orch.completeTicket(t.key, { skipAgent: true });
  expect(moved).toMatchObject({ status: "done", blockedRunKind: null, blockedHead: null });
});

test("a merge that didn't land blocks with the approvals kept, and answering resumes the completion", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: h.project.path });
  git("init", "-b", "main");
  git("commit", "--allow-empty", "-m", "base");
  git("checkout", "-b", "harness/acme-1");
  git("commit", "--allow-empty", "-m", "the work");
  git("checkout", "main");
  h.driver.script(submit(), replyScript("said it merged, but did not"), [{ run: () => void git("merge", "--no-edit", "harness/acme-1") }, ...replyScript("merged for real")]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  h.store.tickets.update(t.id, { branch: "harness/acme-1", hasChanges: true });
  h.orch.humanReview(t.key, { decision: "approve", notes: "Looks good", action: "merge" });
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", blockedRunKind: "complete", humanReview: "approved" });
  expect(h.ticket(t.key).blockedHead).toMatch(/^[0-9a-f]{40}$/);
  await h.orch.unblockTicket(t.key, { notes: "merge it now" });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "complete", "complete"]);
  expect(h.ticket(t.key).status).toBe("done");
});
