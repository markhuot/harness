import { afterEach, expect, test } from "bun:test";
import { toolCall } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const SPEC = "# Add a button\n\n## Open questions\n\n- [ ] Which colour?\n- [x] Which page?\n- [ ] Which label?\n";

test("replies to open questions go to the agent as one message, each quoted under its question, and Activity keeps them", async () => {
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
  const answered = h.store.activity.listBySession(t.sessionId).filter((e) => e.kind === "answered");
  expect(answered).toHaveLength(1);
  expect(answered[0]!.meta.questionReplies).toEqual([{ question: "Which colour?", body: "Blue." }, { question: "Which label?", body: "Save" }]);
});

test("a typed message without replies still writes nothing to Activity", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, start: false });
  await h.settle();
  await h.orch.sendMessage(t.key, "Just a note", { fromApp: true });
  await h.settle();
  expect(h.store.activity.listBySession(t.sessionId).filter((e) => e.kind === "answered")).toEqual([]);
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

test("a reply batch to a blocked ticket answers its question, carrying the replies", async () => {
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
  expect(answered[0]!.meta.questionReplies).toEqual([{ question: "Which label?", body: "Save" }]);
});

test("the draft keeps question replies (blank ones dropped) and a send clears them", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, start: false });
  await h.settle();
  const saved = h.orch.saveMessageDraft(t.key, { text: "", questionReplies: [{ question: "Which colour?", body: "Blue" }, { question: "Which label?", body: "" }], origin: "a" });
  expect(saved.messageDraft).toMatchObject({ text: "", questionReplies: [{ question: "Which colour?", body: "Blue" }] });
  expect(h.orch.saveMessageDraft(t.key, { text: "", questionReplies: [{ question: "Which colour?", body: "" }] }).messageDraft).toBeNull();
  h.orch.saveMessageDraft(t.key, { text: "", questionReplies: [{ question: "Which colour?", body: "Blue" }] });
  await h.orch.sendMessage(t.key, "", { fromApp: true, questionReplies: [{ question: "Which colour?", body: "Blue" }] });
  expect(h.ticket(t.key).messageDraft).toBeNull();
});

test("openQuestionCount follows the spec: the unchecked task items under Open questions", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, start: false });
  await h.settle();
  expect(h.ticket(t.key).openQuestionCount).toBe(2);
  const spec = h.ticket(t.key).spec.replace("- [ ] Which colour?", "- [x] Which colour?");
  await h.orch.updateTicket(t.key, { spec, baseRevision: h.ticket(t.key).specRevision });
  expect(h.ticket(t.key).openQuestionCount).toBe(1);
});
