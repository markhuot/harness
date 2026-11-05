import { afterEach, expect, test } from "bun:test";
import { toolCall } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const SPEC = "# Add a button\n\n## Open questions\n\n- [ ] Which colour?\n- [x] Which page?\n- [ ] Which label?\n";

test("replies to open questions go to the agent as one message, each quoted under its question", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, start: false });
  await h.settle();
  const before = h.driver.requests.length;
  await h.orch.sendMessage(
    t.key,
    "Thanks!",
    { fromApp: true, questionReplies: [{ question: "Which colour?", body: "Blue." }, { question: "Which page?", body: "  " }, { question: "Which label?", body: "Save" }] },
  );
  await h.settle();
  const runs = h.driver.requests.slice(before);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.prompt).toContain("> Which colour?\n\nBlue.\n\n> Which label?\n\nSave\n\nThanks!");
  expect(runs[0]!.prompt).not.toContain("Which page?");
  // Like any message, it goes to the agent and the transcript, not to Activity.
  expect(h.store.activity.listBySession(t.sessionId).filter((e) => e.kind === "answered")).toEqual([]);
});

test("sending the same replies again is another message: it steers or starts a run like typing them would", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, start: false });
  await h.settle();
  const before = h.driver.requests.length;
  const replies = [{ question: "Which colour?", body: "Blue." }];
  await h.orch.sendMessage(t.key, "", { fromApp: true, questionReplies: replies });
  await h.settle();
  await h.orch.sendMessage(t.key, "", { fromApp: true, questionReplies: [{ question: "Which colour?", body: "Blue, the brand one." }] });
  await h.settle();
  const prompts = h.driver.requests.slice(before).map((r) => r.prompt);
  expect(prompts.some((p) => p.includes("> Which colour?\n\nBlue."))).toBe(true);
  expect(prompts.some((p) => p.includes("> Which colour?\n\nBlue, the brand one."))).toBe(true);
});

test("replies alone, with no text, are a message; blank replies and no text are refused", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, start: false });
  await h.settle();
  await expect(h.orch.sendMessage(t.key, "", { questionReplies: [{ question: "Which colour?", body: " " }] })).rejects.toThrow("text is required");
  await expect(h.orch.sendMessage(t.key, "", { questionReplies: [{ question: "Which colour?" }] })).rejects.toThrow("question reply");
  await expect(h.orch.sendMessage(t.key, "", { questionReplies: "Blue" })).rejects.toThrow("array");
  await h.orch.sendMessage(t.key, "", { questionReplies: [{ question: "Which colour?", body: "Red" }] });
  await h.settle();
  expect(h.driver.requests.at(-1)!.prompt).toContain("> Which colour?\n\nRed");
});

test("a message to a blocked ticket is recorded as the answer and reaches a run that can unblock and is told to", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(toolCall("block", { question: "Which colour should it be?" }));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key).status).toBe("blocked");
  const before = h.driver.requests.length;
  await h.orch.sendMessage(t.key, "Blue.", { fromApp: true });
  await h.settle();
  const answered = h.store.activity.listBySession(t.sessionId).filter((e) => e.kind === "answered");
  expect(answered.map((e) => e.body)).toEqual(["Blue."]);
  const run = h.driver.requests.slice(before).find((r) => r.prompt.includes("Blue."))!;
  expect(run.tools.map((x) => x.name)).toContain("unblock");
  expect(run.prompt).toContain("If this message resolves that, call unblock before you continue");
  // Nothing unblocks for the agent: the ticket waits until it calls unblock.
  expect(h.ticket(t.key).status).toBe("blocked");
});

test("a reply batch to a blocked ticket answers its question", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(toolCall("block", { question: "Which colour should it be?" }));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key).status).toBe("blocked");
  await h.orch.sendMessage(t.key, "Go ahead.", { questionReplies: [{ question: "Which label?", body: "Save" }] });
  await h.settle();
  const answered = h.store.activity.listBySession(t.sessionId).filter((e) => e.kind === "answered");
  expect(answered).toHaveLength(1);
  expect(answered[0]!.meta.answers).toBeDefined();
  expect(`${answered[0]!.body}\n${answered[0]!.meta.detail ?? ""}`).toContain("Which label?");
});

test("the draft keeps question replies (blank ones dropped), and a send keeps the replies it sent but clears the rest", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, start: false });
  await h.settle();
  const saved = h.orch.saveMessageDraft(t.key, { text: "", questionReplies: [{ question: "Which colour?", body: "Blue" }, { question: "Which label?", body: "" }], origin: "a" });
  expect(saved.messageDraft).toMatchObject({ text: "", questionReplies: [{ question: "Which colour?", body: "Blue" }] });
  expect(h.orch.saveMessageDraft(t.key, { text: "", questionReplies: [{ question: "Which colour?", body: "" }] }).messageDraft).toBeNull();
  h.orch.saveMessageDraft(t.key, { text: "and one more thing", questionReplies: [{ question: "Which colour?", body: "Blue" }], origin: "a" });
  await h.orch.sendMessage(t.key, "and one more thing", { fromApp: true, questionReplies: [{ question: "Which colour?", body: " Blue " }] });
  expect(h.ticket(t.key).messageDraft).toMatchObject({ text: "", attachments: [], questionReplies: [{ question: "Which colour?", body: "Blue" }], origin: "a" });
  // A send without replies clears the draft as before.
  await h.orch.sendMessage(t.key, "hi", { fromApp: true });
  expect(h.ticket(t.key).messageDraft).toBeNull();
});

test("openQuestionCount follows the spec: every unchecked task item, under any heading", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, start: false });
  await h.settle();
  expect(h.ticket(t.key).openQuestionCount).toBe(2);
  const spec = h.ticket(t.key).spec.replace("- [ ] Which colour?", "- [x] Which colour?");
  await h.orch.updateTicket(t.key, { spec, baseRevision: h.ticket(t.key).specRevision });
  expect(h.ticket(t.key).openQuestionCount).toBe(1);
  const elsewhere = "# Add a button\n\n## Plan\n\n1. Draw it\n   - [ ] Which corner?\n\n- [ ] Rounded?\n";
  await h.orch.updateTicket(t.key, { spec: elsewhere, baseRevision: h.ticket(t.key).specRevision });
  expect(h.ticket(t.key).openQuestionCount).toBe(2);
});
