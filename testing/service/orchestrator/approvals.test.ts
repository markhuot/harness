import { afterEach, expect, test } from "bun:test";
import { FakeDriver, replyScript, toolCall } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";
import type { Classifier } from "../../../service/src/permissions/classifier";
import { CLASSIFIER_DENIED } from "../../../service/src/permissions/gate";

afterEach(stopAll);

const ask = (command: string) => toolCall("permission_prompt", { tool_name: "Bash", input: { command, description: "x" }, tool_use_id: "t1" });
const rig = () => {
  const driver = new FakeDriver({ usesPermissionPromptTool: true });
  const h = makeOrchestrator({ tools: undefined, driver });
  h.store.settings.set({ permissionMode: "ask" });
  return h;
};

test("a tool call the human hasn't approved opens a pending approval, blocks the ticket and tells the agent it's waiting", async () => {
  const h = rig();
  let answer = "";
  h.driver.script(toolCall("permission_prompt", { tool_name: "Bash", input: { command: "rm -rf build" }, tool_use_id: "t1" }, (r) => (answer = JSON.stringify(r))));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Clean up", skipAgentReview: true });
  await h.settle();
  const blocked = h.ticket(t.key);
  expect(blocked.status).toBe("blocked");
  expect(blocked.pendingApproval).toMatchObject({ toolName: "Bash", input: { command: "rm -rf build" }, requestedAt: h.clock() });
  expect(blocked.blockedReason).toContain("Permission needed: Bash");
  expect(answer).toContain("deny");
});

test("allow once grants exactly that call, resumes the work, and the grant is used up", async () => {
  const h = rig();
  h.driver.script(ask("rm -rf build"), [
    ...toolCall("permission_prompt", { tool_name: "Bash", input: { command: "rm -rf build" }, tool_use_id: "t2" }, (r) => (second = JSON.stringify(r))),
  ]);
  let second = "";
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Clean up", skipAgentReview: true });
  await h.settle();
  await h.orch.answerApproval(t.key, { decision: "allow_once" });
  await h.settle();
  expect(h.driver.requests[1]!.prompt).toContain("approved your request to use Bash");
  expect(second).toContain("allow");
  expect(h.store.tickets.listGrants(t.id)).toEqual([]);
  expect(h.ticket(t.key).pendingApproval).toBeNull();
});

test("allow always puts the tool on the ticket so the next call needs no approval", async () => {
  const h = rig();
  let again = "";
  h.driver.script(ask("ls"), toolCall("permission_prompt", { tool_name: "Bash", input: { command: "pwd" }, tool_use_id: "t2" }, (r) => (again = JSON.stringify(r))));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Look around", skipAgentReview: true });
  await h.settle();
  await h.orch.answerApproval(t.key, { decision: "allow_tool" });
  await h.settle();
  expect(h.ticket(t.key).allowedTools).toEqual(["Bash"]);
  expect(again).toContain("allow");
  expect(h.ticket(t.key).pendingApproval).toBeNull();
});

test("denying tells the agent, with the human's note, to find another way", async () => {
  const h = rig();
  h.driver.script(ask("rm -rf /tmp/x"), replyScript("ok"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Clean up", skipAgentReview: true });
  await h.settle();
  await h.orch.answerApproval(t.key, { decision: "deny", message: "Use trash instead." });
  await h.settle();
  expect(h.driver.requests[1]!.prompt).toContain("The human denied Bash");
  expect(h.driver.requests[1]!.prompt).toContain("Use trash instead.");
  expect(h.ticket(t.key).allowedTools).toEqual([]);
});

test("answering with no approval pending, or with a bad decision, is refused", async () => {
  const h = rig();
  h.driver.script(ask("ls"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  await expect(h.orch.answerApproval(t.key, { decision: "maybe" as never })).rejects.toThrow(/decision must be/);
  await h.orch.answerApproval(t.key, { decision: "deny" });
  await h.settle();
  await expect(h.orch.answerApproval(t.key, { decision: "deny" })).rejects.toThrow(/no pending approval/);
});

test("a message sent while an approval is pending counts as a denial carrying the message", async () => {
  const h = rig();
  h.driver.script(ask("rm -rf build"), replyScript("ok"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Clean up", skipAgentReview: true });
  await h.settle();
  await h.orch.sendMessage(t.key, "no, don't delete anything");
  await h.settle();
  expect(h.ticket(t.key).pendingApproval).toBeNull();
  expect(h.driver.requests[1]!.prompt).toContain("don't delete anything");
});

test("in read-only mode nothing goes to a human: the call is denied with a reason and no approval opens", async () => {
  const h = rig();
  h.store.settings.set({ permissionMode: "read_only" });
  let answer = "";
  h.driver.script(toolCall("permission_prompt", { tool_name: "Bash", input: { command: "touch x" }, tool_use_id: "t1" }, (r) => (answer = JSON.stringify(r))));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(answer).toContain("read-only");
  expect(h.ticket(t.key).pendingApproval).toBeNull();
});

test("review runs get no approvals: the call is denied with guidance to carry on without it", async () => {
  const h = rig();
  let answer = "";
  h.driver.script(
    toolCall("submit_for_review", { note: "n", spec_is_up_to_date: true }),
    toolCall("permission_prompt", { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t1" }, (r) => (answer = JSON.stringify(r))),
  );
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
  await h.settle();
  expect(answer).toContain("No human is available to approve tools during a review run");
  expect(h.ticket(t.key).pendingApproval).toBeNull();
});

test("a denial by the driver's permission policy on a run that ends becomes a pending approval carrying the reason", async () => {
  const h = rig();
  h.driver.script([{ type: "permission_denied", callId: "c1", toolName: "Bash", input: { command: "git push" }, reason: "not allowed by the ticket's permission mode" }, ...replyScript("I couldn't push.")]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Ship it", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", pendingApproval: { toolName: "Bash", source: "policy", reason: "not allowed by the ticket's permission mode" } });
});

test("a classifier soft denial goes back to the agent: when it then blocks for its own reason, its question stands and no approval opens", async () => {
  const driver = new FakeDriver({ id: "claude-code", usesPermissionPromptTool: true });
  const classifier: Classifier = { backend: "fake", classify: async () => ({ decision: "soft_deny", reason: "modifies shared data" }) };
  const h = makeOrchestrator({ tools: undefined, driver, classifier });
  h.store.settings.set({ permissionMode: "auto" });
  let answer = "";
  h.driver.script([
    ...toolCall("permission_prompt", { tool_name: "Bash", input: { command: "drush php:script patch.php" }, tool_use_id: "t1" }, (r) => (answer = JSON.stringify(r))),
    ...toolCall("block", { question: "Should I ship on unit tests alone?" }),
  ]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Card page", skipAgentReview: true });
  await h.settle();
  expect(answer).toContain(CLASSIFIER_DENIED);
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", pendingApproval: null, blockedReason: "Should I ship on unit tests alone?" });
});

test("only one approval is open at a time: a second request while one waits is denied and doesn't replace it", async () => {
  const h = rig();
  let second = "";
  h.driver.script([
    ...toolCall("permission_prompt", { tool_name: "Bash", input: { command: "first" }, tool_use_id: "t1" }),
    ...toolCall("permission_prompt", { tool_name: "Bash", input: { command: "second" }, tool_use_id: "t2" }, (r) => (second = JSON.stringify(r))),
  ]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
  await h.settle();
  expect(second).toContain("deny");
  expect(h.ticket(t.key).pendingApproval).toMatchObject({ input: { command: "first" } });
  expect(h.store.activity.listBySession(t.sessionId).filter((a) => a.kind === "permission")).toHaveLength(1);
});
