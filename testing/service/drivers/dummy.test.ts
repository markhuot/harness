import { afterEach, expect, test } from "bun:test";
import { DummyDriver } from "../../../service/src/drivers/dummy";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const rig = (opts: Parameters<typeof makeOrchestrator>[0] = {}) => makeOrchestrator({ ...opts, tools: undefined, driver: new DummyDriver({ delayMs: 0 }) });
const texts = (h: ReturnType<typeof rig>, sessionId: string) => h.store.transcript.list(sessionId).flatMap((e) => (e.content.type === "text" ? [e.content.text] : []));
const statuses = (h: ReturnType<typeof rig>, sessionId: string) => h.store.transcript.list(sessionId).flatMap((e) => (e.content.type === "status" ? [e.content.text] : []));

test("a work run greets with what it was told, notes its Status in the spec, and submits", async () => {
  const h = rig();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a dark mode\n\n## Status\nnot started", skipAgentReview: true });
  await h.settle();
  expect(texts(h, t.sessionId).some((x) => x.startsWith('Hello from the dummy driver! You said: "Add a dark mode'))).toBe(true);
  expect(h.ticket(t.key).status).toBe("review");
  expect(h.ticket(t.key).spec).toMatch(/## Status\n\* /);
  expect(h.ticket(t.key).specRevision).toBeGreaterThan(1);
});

test("/block asks its question and blocks; /fail ends the run in an error", async () => {
  const blocked = rig();
  const a = await blocked.orch.createTicket({ projectId: blocked.project.id, spec: "/block Which colour?", skipAgentReview: true });
  await blocked.settle();
  expect(blocked.ticket(a.key)).toMatchObject({ status: "blocked", blockedReason: "Which colour?" });
  const failed = rig();
  const b = await failed.orch.createTicket({ projectId: failed.project.id, spec: "/fail it broke", skipAgentReview: true });
  await failed.settle();
  expect(failed.ticket(b.key).status).toBe("blocked");
  expect(failed.store.runs.listBySession(b.sessionId)[0]).toMatchObject({ status: "failed", error: "it broke" });
});

test("/tools calls the harness tools it's given in order, stopping at the first error", async () => {
  const h = rig();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: '/tools [{"name":"post_note","input":{"note":"first"}},{"name":"post_note","input":{"note":""}},{"name":"post_note","input":{"note":"never"}}]', skipAgentReview: true });
  await h.settle();
  const notes = h.store.activity.listBySession(t.sessionId).filter((a) => a.kind === "note").map((a) => a.body);
  expect(notes).toEqual(["first"]);
});

test("a plan run drafts a plan into the spec and leaves the ticket in planning", async () => {
  const h = rig();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a dark mode", start: false });
  await h.settle();
  expect(h.ticket(t.key).status).toBe("planning");
  expect(h.ticket(t.key).spec).toContain("Here's a plan for: Add a dark mode");
  expect(h.store.specs.list(t.id).map((r) => [r.author, r.runKind])).toEqual([["system", null], ["agent", "plan"]]);
  expect(h.store.activity.listBySession(t.sessionId).some((a) => a.kind === "spec_revised" && a.body === "Plan drafted")).toBe(true);
});

test("a review run approves, unless the prompt says to reject; reject-once rejects only the first round", async () => {
  const approving = rig();
  const a = await approving.orch.createTicket({ projectId: approving.project.id, spec: "fine work" });
  await approving.settle();
  expect(approving.ticket(a.key)).toMatchObject({ agentReview: "approved", status: "review" });

  const rejecting = rig();
  const b = await rejecting.orch.createTicket({ projectId: rejecting.project.id, spec: "[dummy:reject-once] work" });
  await rejecting.settle();
  // Round 1 requests changes, the work is redone, round 2 approves.
  expect(rejecting.store.runs.listBySession(b.sessionId).map((r) => r.kind)).toEqual(["work", "review", "work", "review"]);
  expect(rejecting.ticket(b.key).agentReview).toBe("approved");
});

test("a chat answers in its own voice, and the directives in the message change the ticket", async () => {
  const h = rig();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "/block Colour?", skipAgentReview: true });
  await h.settle();
  await h.orch.sendMessage(t.key, "blue [dummy:unblock]");
  await h.settle();
  expect(texts(h, t.sessionId).some((x) => x.startsWith('(dummy chat) You said: "blue'))).toBe(true);
  expect(h.store.activity.listBySession(t.sessionId).map((a) => a.kind)).toContain("unblocked");
});

test("a chief of staff run answers in words, and /tools in its message creates tickets under its name", async () => {
  const h = rig();
  const cos = h.orch.openCos("all");
  const sessionId = h.ticket(cos.key).sessionId;
  await h.orch.sendMessage(cos.key, "good morning");
  await h.settle();
  expect(texts(h, sessionId).some((x) => x.startsWith("(dummy chief) Noted: good morning"))).toBe(true);
  const calls = [
    { name: "create_ticket", input: { title: "Spike: pick a queue", spec: "Compare two queues", project_key: h.project.key, start: false } },
    { name: "create_ticket", input: { title: "Build: the queue", spec: "Wire it up", project_key: h.project.key, start: false } },
  ];
  await h.orch.sendMessage(cos.key, `/tools ${JSON.stringify(calls)}`);
  await h.settle();
  const made = h.store.tickets.list({ projectId: h.project.id }).filter((t) => t.title.startsWith("Spike:") || t.title.startsWith("Build:"));
  expect(made.map((t) => t.status)).toEqual(["planning", "planning"]);
  expect(h.store.activity.listBySession(made[0]!.sessionId).map((e) => e.body)).toContain(`Chief of staff (${cos.key}) created it`);
  // A chief has no submit_for_review, so the run ends in words and the ticket stays a chief.
  expect(h.ticket(cos.key).kind).toBe("cos");
  expect(texts(h, sessionId).some((x) => x === "Ran create_ticket, create_ticket.")).toBe(true);
});

test("/approve goes through the same approval path claude-code uses: a card on the ticket, then the work goes on when allowed", async () => {
  const h = rig();
  h.store.settings.set({ permissionMode: "ask" });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: '/approve Bash {"command":"rm -rf build"}', skipAgentReview: true });
  await h.settle();
  expect(h.ticket(t.key).pendingApproval).toMatchObject({ toolName: "Bash", input: { command: "rm -rf build" } });
  await h.orch.answerApproval(t.key, { decision: "allow_once" });
  await h.settle();
  // The answer started a new run, which carries on and submits.
  expect(h.ticket(t.key)).toMatchObject({ status: "review", pendingApproval: null });
  expect(h.store.runs.listBySession(t.sessionId).map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
});

test("a conductor's first run creates a child per bullet in its prompt", async () => {
  const h = rig();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Split this\n- Build the API\n- Build the UI", kind: "conductor", skipAgentReview: true });
  await h.settle();
  expect(h.store.tickets.list({ parentId: t.id }).map((c) => [c.title, c.dependsOn])).toEqual([["Build the API", []], ["Build the UI", []]]);
});

test("without bullets a conductor makes two children, the second depending on the first", async () => {
  const h = rig();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Split this", kind: "conductor", skipAgentReview: true });
  await h.settle();
  const [first, second] = h.store.tickets.list({ parentId: t.id });
  expect([first!.title, second!.title]).toEqual(["Part 1", "Part 2"]);
  expect(second!.dependsOn).toEqual([first!.key]);
});

test("an unknown model fails the run the way a real API rejects it", async () => {
  const h = rig();
  h.store.settings.set({ phaseModels: { work: { driver: "dummy", model: "not-a-model" }, plan: { driver: "dummy", model: null }, review: { driver: "dummy", model: null }, complete: { driver: "dummy", model: null }, adviser: { driver: "dummy", model: null } } });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "work", skipAgentReview: true });
  await h.settle();
  expect(h.store.runs.listBySession(t.sessionId)[0]!.status).toBe("failed");
  expect(statuses(h, t.sessionId).length).toBeGreaterThan(0);
});
