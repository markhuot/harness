import { afterEach, expect, test } from "bun:test";
import { replyScript } from "../fake-driver";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";
import { gitRepo } from "../git";

afterEach(stopAll);

const submitCall: [string, unknown] = ["submit_for_review", { note: "done", spec_is_up_to_date: true }];

test("return_to_planning moves the ticket back at once and a plan run follows the work run, with the reason and the human's words", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const work = callTools([["return_to_planning", { reason: "The approach won't work: the API is read-only." }]]);
  h.driver.script(work.steps, replyScript("new plan"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  expect(work.results[0]!.isError).toBe(false);
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "plan"]);
  expect(h.driver.requests[1]!.prompt).toContain("The approach won't work");
  expect(h.ticket(t.key)).toMatchObject({ status: "planning", agentReview: "pending", autoStart: false });
});

test("return_to_planning needs a reason, and a ticket already in planning can't be sent back", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const work = callTools([["return_to_planning", { reason: "   " }], ["return_to_planning", { reason: "first" }], ["return_to_planning", { reason: "again" }]]);
  h.driver.script(work.steps);
  await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(work.results.map((r) => r.isError)).toEqual([true, false, true]);
  expect(work.results[2]!.text).toContain("already in planning");
});

test("with start_after_plan the plan run's approval starts the work again on its own", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const work = callTools([["return_to_planning", { reason: "Re-plan", start_after_plan: true }]]);
  h.driver.script(work.steps, replyScript("plan"), replyScript("second work"));
  await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work", "plan", "work"]);
});

test("a chat on a ticket in review that decides to change the work moves it back to in progress with both reviews reset", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const first = callTools([submitCall]);
  const chat = callTools([["resume_work", { note: "Changing the label" }]]);
  h.driver.script(first.steps, chat.steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key).status).toBe("review");
  await h.orch.sendMessage(t.key, "please change the label");
  await h.settle();
  expect(h.driver.requests[1]!.kind).toBe("chat");
  expect(chat.results[0]).toMatchObject({ isError: false });
  const statuses = h.store.transcript.list(t.sessionId).flatMap((e) => (e.content.type === "status" ? [e.content.text] : []));
  expect(statuses).toContain("Moved back to in progress by the agent: Changing the label");
  expect(h.ticket(t.key).humanReview).toBe("pending");
});

test("resume_work only applies to a ticket in review or done", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const work = callTools([["resume_work", {}]]);
  h.driver.script(work.steps);
  await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(work.results[0]!.isError).toBe(true);
  expect(work.results[0]!.text).toContain("not in review or done");
});

test("unblock only applies to a blocked ticket", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const work = callTools([["unblock", {}]]);
  h.driver.script(work.steps);
  await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(work.results[0]!.text).toContain("not blocked");
});

test("block and submit don't apply to a ticket still in planning", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const plan = callTools([["block", { question: "q?" }], submitCall]);
  h.driver.script(plan.steps);
  await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
  await h.settle();
  // A plan run doesn't have these tools at all.
  expect(plan.results.map((r) => r.text)).toEqual(["Unknown tool: block", "Unknown tool: submit_for_review"]);
});

test("a parent can't submit while its children are open", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "p", kind: "conductor", start: false });
  await h.settle();
  await h.orch.createTicket({ projectId: h.project.id, spec: "child", parentId: parent.key, skipAgentReview: true });
  await h.settle();
  const conduct = callTools([submitCall]);
  h.driver.script(conduct.steps);
  await h.orch.startTicket(parent.key);
  await h.settle();
  expect(conduct.results[0]!.isError).toBe(true);
  expect(conduct.results[0]!.text).toMatch(/still has child tickets that aren't done \(ACME-2: review\)/);
});

test("the agent turning off the reviews at submit time is recorded in the transcript", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const work = callTools([["submit_for_review", { note: "n", spec_is_up_to_date: true, skip_agent_review: true }]]);
  h.driver.script(work.steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
  await h.settle();
  expect(h.ticket(t.key).skipAgentReview).toBe(true);
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work"]);
  expect(h.store.transcript.list(t.sessionId).some((e) => e.content.type === "status" && e.content.text.includes("turned off the agent review"))).toBe(true);
});

test("record_pull_request is only for a completion that opens a pull request, and checks the link and the commit", async () => {
  const repo = gitRepo();
  const h = makeOrchestrator({ tools: undefined });
  const project = h.orch.createProject({ path: repo, key: "GIT", useWorktrees: false });
  const work = callTools([["record_pull_request", { url: "https://github.com/o/r/pull/1", head: "abcdef1" }]]);
  h.driver.script(work.steps);
  await h.orch.createTicket({ projectId: project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  // A work run doesn't get the tool at all.
  expect(work.results[0]!.text).toBe("Unknown tool: record_pull_request");
});
