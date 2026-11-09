import { afterEach, expect, test } from "bun:test";
import type { Ticket } from "@harness/shared";
import { toolCall } from "../fake-driver";
import { makeOrchestrator, stopAll, type OrchestratorRig } from "../orchestrator-harness";

afterEach(stopAll);

const submit = () => toolCall("submit_for_review", { note: "done", spec_is_up_to_date: true });

/** The last ticket.upserted the bus sent for a ticket: what every client shows. */
function lastUpsert(h: OrchestratorRig, key: string): Ticket | undefined {
  return h.events.flatMap((e) => (e.kind === "ticket.upserted" && e.ticket.key === key ? [e.ticket] : [])).at(-1);
}

async function inReview(h: OrchestratorRig) {
  h.driver.script(submit());
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key).status).toBe("review");
  return t.key;
}

test("a ticket the agent submits arrives in Review unseen, and every client is told last", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const key = await inReview(h);
  expect(h.ticket(key).unseen).toBe(true);
  expect(lastUpsert(h, key)?.unseen).toBe(true);
});

test("marking seen and unseen flips the flag without Activity or an updatedAt change; a no-op emits nothing", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const key = await inReview(h);
  const before = h.ticket(key);
  const activity = h.orch.activity(key).length;

  expect(h.orch.setSeen(key, { seen: true }).unseen).toBe(false);
  expect(lastUpsert(h, key)?.unseen).toBe(false);
  const emitted = h.events.length;
  h.orch.setSeen(key, { seen: true });
  expect(h.events.length).toBe(emitted);

  expect(h.orch.setSeen(key, { seen: false }).unseen).toBe(true);
  expect(lastUpsert(h, key)?.unseen).toBe(true);
  expect(h.ticket(key).updatedAt).toBe(before.updatedAt);
  expect(h.orch.activity(key).length).toBe(activity);
});

test("setSeen refuses a body without a boolean seen", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const key = await inReview(h);
  expect(() => h.orch.setSeen(key, {} as never)).toThrow(/seen must be a boolean/);
  expect(() => h.orch.setSeen(key, { seen: "yes" } as never)).toThrow(/seen must be a boolean/);
});

test("the human's own spec edit leaves a seen ticket seen", async () => {
  const h = makeOrchestrator({ tools: undefined });
  const key = await inReview(h);
  h.orch.setSeen(key, { seen: true });
  await h.orch.updateTicket(key, { spec: "Add a blue button", baseRevision: h.ticket(key).specRevision });
  expect(h.orch.activity(key).at(-1)).toMatchObject({ kind: "spec_revised", author: "human" });
  expect(h.ticket(key).unseen).toBe(false);
});

test("a block question, and the submit after the human's answer, each make a seen ticket unseen again", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script(toolCall("block", { question: "Which colour?" }));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", unseen: true });
  h.orch.setSeen(t.key, { seen: true });

  h.driver.script(submit());
  await h.orch.sendMessage(t.key, "Blue");
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "review", unseen: true });
});

test("an agent's note on a seen ticket makes it unseen", async () => {
  const h = makeOrchestrator({ tools: undefined });
  h.driver.script([...toolCall("post_note", { note: "Halfway" }), ...submit()]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipAgentReview: true, start: false });
  await h.settle();
  h.orch.setSeen(t.key, { seen: true });
  expect(h.ticket(t.key).unseen).toBe(false);
  await h.orch.startTicket(t.key);
  await h.settle();
  expect(h.orch.activity(t.key).some((e) => e.kind === "note" && e.author === "agent")).toBe(true);
  expect(h.ticket(t.key).unseen).toBe(true);
});
