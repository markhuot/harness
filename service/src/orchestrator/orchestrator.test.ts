import { describe, expect, test } from "bun:test";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, Ticket } from "@harness/shared";
import { FakeDriver, makeOrchestrator, tempHome } from "../testing/fakes";
import { toolsForRun } from "../tools";
import { HarnessError } from "./errors";

function setup(opts: { skipAgentReview?: boolean; skipHumanReview?: boolean; driver?: FakeDriver; realTools?: boolean } = {}) {
  const h = makeOrchestrator({ driver: opts.driver, ...(opts.realTools ? { tools: toolsForRun } : {}) });
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, skipAgentReview: opts.skipAgentReview, skipHumanReview: opts.skipHumanReview });
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, project, events };
}

const statuses = (h: ReturnType<typeof setup>, sessionId: string) =>
  h.store.transcript
    .list(sessionId)
    .filter((e) => e.content.type === "status")
    .map((e) => (e.content as { text: string }).text);

/** The agent's last text in the transcript: its answer to a message. */
const lastText = (h: ReturnType<typeof setup>, sessionId: string) =>
  h.store.transcript
    .list(sessionId)
    .filter((e) => e.role === "assistant" && e.content.type === "text")
    .map((e) => (e.content as { text: string }).text)
    .at(-1);

const runKinds = (h: ReturnType<typeof setup>, t: Ticket) => h.store.runs.listBySession(t.sessionId).map((r) => `${r.kind}:${r.status}`);

describe("ticket lifecycle", () => {
  test("start:true runs work with the brief, auto-reviews, then Complete with instructions → done", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    expect(t.key).toBe("ACME-1");
    expect(t.status).toBe("in_progress");
    expect(t.busy).toBe(true);
    await h.orch.idle();

    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("review");
    expect(cur.agentReview).toBe("approved");
    expect(cur.humanReview).toBe("pending");
    expect(cur.busy).toBe(false);
    expect(h.driver.calls[0]!.prompt).toBe("Add a button");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded"]);

    await h.orch.completeTicket(t.key, { instructions: "merge it" });
    await h.orch.idle();
    cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
    expect(h.driver.calls.at(-1)!.prompt).toContain("merge it");

    const st = statuses(h, t.sessionId);
    expect(st).toContain("Run started (work)");
    expect(st).toContain("Moved to review");
    expect(st.at(-1)).toBe("Completed");
    const activity = h.orch.activity(t.key).map((s) => `${s.kind}:${s.author}:${s.body}`);
    expect(activity).toContain("submitted:agent:All done.");
  });

  test("start:false plans (update_spec), then /start runs the approved plan", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Refactor auth", start: false });
    expect(t.status).toBe("planning");
    await h.orch.idle();
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("planning");
    expect(cur.spec).toBe("1. Do Refactor auth");
    expect(h.driver.calls.map((c) => c.kind)).toEqual(["plan"]);

    await h.orch.sendMessage(t.key, "also do tests");
    await h.orch.idle();
    expect(h.driver.calls.map((c) => c.kind)).toEqual(["plan", "plan"]);
    expect(h.driver.calls[1]!.prompt).toBe("also do tests");

    await h.orch.startTicket(t.key);
    await h.orch.idle();
    cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("review");
    const work = h.driver.calls.find((c) => c.kind === "work")!;
    expect(work.prompt).toContain("The spec is approved");
    expect(work.prompt).toContain("1. Do also do tests");
    await expect(h.orch.startTicket(t.key)).rejects.toBeInstanceOf(HarnessError);
  });

  test("Start starts the work fresh; review runs start fresh and never write state", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    await h.orch.idle();
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 1 });
    await h.orch.sendMessage(t.key, "more");
    await h.orch.idle();
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    const [plan, plan2, work, review] = h.driver.calls;
    expect(plan!.state).toBeNull();
    // A second planning run with no move in between resumes the first.
    expect(plan2!.state).toEqual({ turns: 1 });
    // Moving out of planning: the work doesn't carry on the planning conversation.
    expect(work!.kind).toBe("work");
    expect(work!.state).toBeNull();
    expect(review!.kind).toBe("review");
    expect(review!.state).toBeNull();
    // The submit moved the card to review, so the work's conversation is dropped, and the
    // reviewer's { reviewer: true } state must not leak into the session.
    expect(h.store.sessions.getDriverState(t.sessionId)).toBeNull();
  });

  test("requested changes start a fresh work conversation", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "request_changes", notes: "rename it" });
    await h.orch.idle();
    const works = h.driver.calls.filter((c) => c.kind === "work");
    expect(works.map((c) => c.state)).toEqual([null, null]);
  });

  test("chats in review: the first after the submit starts fresh, a second resumes it", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "why?");
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "and then?");
    await h.orch.idle();
    const chats = h.driver.calls.filter((c) => c.kind === "chat");
    expect(chats.map((c) => c.state)).toEqual([null, { turns: 1 }]);
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 2 });
  });

  test("blocked → in progress resumes the conversation running when the ticket blocked", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 1 });
    // The human drags the card back to in progress: the restart carries on.
    await h.orch.updateTicket(t.key, { status: "in_progress" });
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "work").map((c) => c.state)).toEqual([null, { turns: 1 }]);

    // The human's answer, from the chat, resumes it too.
    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which port?" });
    await h.orch.idle();
    await h.orch.sendMessage(b.key, "5432 /unblock /submit");
    await h.orch.idle();
    const chat = h.driver.calls.find((c) => c.kind === "chat" && c.prompt.startsWith("5432"))!;
    expect(chat.state).toEqual({ turns: 1 });
  });

  test("a failed run → blocked → restart resumes the failed run's conversation", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x /fail boom" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("blocked");
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 1 });
    await h.orch.updateTicket(t.key, { status: "in_progress" });
    await h.orch.idle();
    const works = h.driver.calls.filter((c) => c.kind === "work");
    expect(works).toHaveLength(2);
    expect(works[1]!.state).toEqual({ turns: 1 });
  });

  test("a complete run starts fresh and saves nothing; chats on Done start a new conversation and keep it", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { instructions: "merge it" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    const complete = h.driver.calls.find((c) => c.kind === "complete")!;
    expect(complete.state).toBeNull();
    // Neither the completer's state nor the work's survives into done.
    expect(h.store.sessions.getDriverState(t.sessionId)).toBeNull();

    await h.orch.sendMessage(t.key, "what did you change?");
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "and why?");
    await h.orch.idle();
    const chats = h.driver.calls.filter((c) => c.kind === "chat");
    expect(chats.map((c) => c.state)).toEqual([null, { turns: 1 }]);
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 2 });
  });

  test("a reopened ticket starts its work fresh", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { instructions: "merge it" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "a question");
    await h.orch.idle();
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 1 });
    await h.orch.reopenTicket(t.key, { notes: "one more fix" });
    await h.orch.idle();
    const works = h.driver.calls.filter((c) => c.kind === "work");
    expect(works).toHaveLength(2);
    expect(works[1]!.state).toBeNull();
  });

  test("a run that outlives its phase doesn't write its conversation back", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x /hold /nosubmit" });
    while (h.driver.holding === 0) await Bun.sleep(1);
    await h.orch.updateTicket(t.key, { status: "done" });
    h.driver.release();
    await h.orch.idle();
    expect(runKinds(h, t)).toEqual(["work:succeeded"]);
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(h.store.sessions.getDriverState(t.sessionId)).toBeNull();
  });

  test("block → blocked; the human's answer resumes the agent with its tools, which unblocks and submits", async () => {
    const h = setup({ realTools: true });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toBe("Which database?");
    expect(h.orch.activity(t.key).map((s) => [s.kind, s.author, s.body, s.meta.question])).toContainEqual(["blocked", "agent", "Which database?", "Which database?"]);
    // blocked runs do not auto-submit and do not get a review
    expect(runKinds(h, t)).toEqual(["work:succeeded"]);
    const workTools = h.driver.calls[0]!.toolNames;

    // The message moves nothing: the agent decides.
    cur = await h.orch.sendMessage(t.key, "Postgres /unblock /submit");
    expect(cur.status).toBe("blocked");
    await h.orch.idle();
    const chat = h.driver.calls[1]!;
    expect(chat.kind).toBe("chat");
    expect(chat.toolNames).toEqual(workTools);
    for (const tool of ["block", "unblock", "submit_for_review"]) expect(chat.toolNames).toContain(tool);
    // The agent reads the question it's answering; the transcript keeps what the human typed.
    expect(chat.prompt).toStartWith("Postgres /unblock /submit\n\n[Harness note: this ticket is blocked on: Which database?.");
    expect(h.store.transcript.list(t.sessionId).some((e) => e.content.type === "text" && e.content.text === "Postgres /unblock /submit")).toBe(true);
    expect(h.store.transcript.list(t.sessionId).some((e) => e.content.type === "text" && e.content.text.includes("[Harness note"))).toBe(false);

    cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur).toMatchObject({ status: "review", blockedReason: null, agentReview: "approved" });
    expect(statuses(h, t.sessionId)).toContain("Unblocked by the agent: answered");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "chat:succeeded", "review:succeeded"]);
    // One agent answer: the submit note, not the chat's last text as well (then the reviewer's).
    const after = h.orch.activity(t.key).map((s) => `${s.kind}:${s.author}:${s.body}`);
    expect(after.slice(after.indexOf("unblocked:agent:answered"))).toEqual([
      "unblocked:agent:answered",
      "submitted:agent:Done from chat.",
      "review_approved:agent:LGTM",
    ]);
    // The card went blocked → in progress (while the agent worked) → review.
    const st = statuses(h, t.sessionId);
    expect(st.indexOf("Unblocked by the agent: answered")).toBeLessThan(st.indexOf("Moved to review"));
  });

  test("work run that ends without submitting is auto-submitted with the last assistant text", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "quiet /nosubmit" });
    await h.orch.idle();
    const d = h.orch.ticketDetail(t.key);
    expect(d.ticket.status).toBe("review");
    const sys = d.activity.find((s) => s.kind === "submitted")!;
    expect(sys).toMatchObject({ author: "system", body: 'Hello from fake! You said: "quiet /nosubmit"' });
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded"]);
  });

  test("auto-submit is skipped while another human message is queued", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "first /hold /nosubmit" });
    await Bun.sleep(5);
    await h.orch.sendMessage(t.key, "second /nosubmit");
    h.driver.release();
    await h.orch.idle();
    // Only the second run's end triggers the submit
    const sys = h.orch.activity(t.key).filter((s) => s.author === "system" && s.kind === "submitted");
    expect(sys.map((s) => s.body)).toEqual(['Hello from fake! You said: "second /nosubmit"']);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "work:succeeded", "review:succeeded"]);
  });

  test("work run failure (error event or thrown) → blocked with the error", async () => {
    const h = setup();
    const a = await h.orch.createTicket({ projectId: h.project.id, spec: "/fail disk full" });
    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "/throw kaboom" });
    await h.orch.idle();
    const ta = h.orch.ticketDetail(a.key).ticket;
    expect(ta.status).toBe("blocked");
    expect(ta.blockedReason).toBe("disk full");
    expect(h.orch.ticketDetail(a.key).runs[0]!.status).toBe("failed");
    const tb = h.orch.ticketDetail(b.key).ticket;
    expect(tb.blockedReason).toBe("kaboom");
    // The detail view has no blocked callout; Activity is where the reason shows.
    expect(h.orch.activity(a.key).map((s) => [s.kind, s.author, s.body, s.meta.to])).toEqual([
      ["moved", "human", "Work started", "in_progress"],
      ["failed", "system", "Run failed: disk full", "blocked"],
    ]);
    expect(h.orch.activity(b.key).map((s) => s.body)).toEqual(["Work started", "Run failed: kaboom"]);
    expect(h.store.transcript.list(a.sessionId).some((e) => e.content.type === "error" && e.content.text === "disk full")).toBe(true);
  });

  test("agent request_changes loops back to work until the reviewer approves", async () => {
    const driver = new FakeDriver();
    driver.rejectsLeft = 2;
    const h = setup({ driver });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "loop" });
    await h.orch.idle();
    const d = h.orch.ticketDetail(t.key);
    expect(d.ticket.status).toBe("review");
    expect(d.ticket.agentReview).toBe("approved");
    expect(runKinds(h, t)).toEqual([
      "work:succeeded",
      "review:succeeded",
      "work:succeeded",
      "review:succeeded",
      "work:succeeded",
      "review:succeeded",
    ]);
    const workPrompts = h.driver.calls.filter((c) => c.kind === "work").map((c) => c.prompt);
    expect(workPrompts[1]).toContain("Please fix X");
    expect(workPrompts[1]).toContain("reviewer agent");
  });

  test("human request_changes resets both reviews and re-runs work with the notes", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const cur = h.orch.humanReview(t.key, { decision: "request_changes", notes: "rename it" });
    expect(cur.status).toBe("in_progress");
    expect(cur.agentReview).toBe("pending");
    expect(cur.humanReview).toBe("pending");
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "work").at(-1)!.prompt).toContain("rename it");
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    expect(() => h.orch.humanReview("ACME-99", { decision: "approve" })).toThrow(/Unknown ticket/);
  });

  test("tickets of a project that skips the human review complete right after the agent approves, with the project's default action", async () => {
    const h = setup({ skipHumanReview: true });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.agentReview, cur.humanReview, cur.completionAction]).toEqual(["done", "approved", "approved", "custom"]);
    expect(statuses(h, t.sessionId)).toContain("Both reviews approved: completing automatically");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
  });

  test("the human approval completes the ticket without pressing Complete", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    // Agent approved, human pending: nothing runs yet.
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded"]);

    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
    const st = statuses(h, t.sessionId);
    expect(st).toContain("Both reviews approved: completing automatically");
    expect(st).not.toContain("Ready to complete");
  });

  test("approving while the agent review runs waits for it; its approval then completes with the chosen action", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]" });
    while (h.driver.holding === 0) await Bun.sleep(1);
    const approved = h.orch.humanReview(t.key, { decision: "approve", action: "custom", instructions: "tag it" });
    expect([approved.status, approved.agentReview, approved.humanReview]).toEqual(["review", "pending", "approved"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:running"]);
    h.driver.release();
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.completionAction]).toEqual(["done", "custom"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
    expect(h.driver.calls.at(-1)!.prompt).toContain("tag it");
  });

  test("the agent approval completes the ticket when the human review was pre-approved", async () => {
    const driver = new FakeDriver();
    driver.rejectsLeft = 1;
    const h = setup({ driver, skipHumanReview: true });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    // Human review is pre-approved; the first agent review rejects, the second approves and completes.
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "work:succeeded", "review:succeeded", "complete:succeeded"]);
  });

  test("a second Complete while the approval's complete run is queued is refused", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await expect(h.orch.completeTicket(t.key)).rejects.toThrow(/already completing/);
    await h.orch.idle();
    expect(runKinds(h, t).filter((k) => k.startsWith("complete"))).toEqual(["complete:succeeded"]);
  });

  test("cancelling a running completion puts the approval back; approving again lands it", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    let started = false;
    h.driver.script = async function* (req) {
      if (req.kind !== "complete") return;
      started = true;
      await new Promise<void>((r) => req.signal.addEventListener("abort", () => r(), { once: true }));
    };
    h.orch.humanReview(t.key, { decision: "approve", action: "custom", instructions: "tag it" });
    while (!started) await Bun.sleep(2);
    await h.orch.cancelTicket(t.key);
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    // Still in review with the agent's approval; the human's is open again, the choice kept.
    expect([cur.status, cur.agentReview, cur.humanReview, cur.completionAction]).toEqual(["review", "approved", "pending", "custom"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:cancelled"]);
    expect(statuses(h, t.sessionId)).toContain("Completion cancelled: approve again to land it");

    h.driver.script = null;
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:cancelled", "complete:succeeded"]);
  });

  test("cancelling a completion still queued behind another run puts the approval back too", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]" });
    while (h.driver.holding === 0) await Bun.sleep(1);
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.completeTicket(t.key); // queued behind the held review
    await h.orch.cancelTicket(t.key);
    h.driver.release();
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.humanReview]).toEqual(["review", "pending"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:cancelled", "complete:cancelled"]);
    expect(statuses(h, t.sessionId)).toContain("Completion cancelled: approve again to land it");
  });

  test("while the complete run is in flight, a message or request for changes is refused and the ticket ends done", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started = false;
    h.driver.script = async function* (req) {
      if (req.kind !== "complete") return;
      started = true;
      await gate;
    };
    await h.orch.completeTicket(t.key);
    // Queued, then running: both count as completing.
    await expect(h.orch.sendMessage(t.key, "merge into main instead")).rejects.toThrow(/is completing/);
    while (!started) await Bun.sleep(2);
    await expect(h.orch.sendMessage(t.key, "never mind")).rejects.toThrow(/is completing/);
    expect(() => h.orch.humanReview(t.key, { decision: "request_changes", notes: "redo" })).toThrow(/is completing/);
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    open();
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
  });

  test("a work run that fails after its ticket was marked done leaves it done", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    h.driver.script = async function* (req) {
      if (req.kind !== "work") return;
      await h.orch.completeTicket(t.key, { skipAgent: true });
      yield { type: "error", message: "Working directory does not exist" };
    };
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.blockedReason]).toEqual(["done", null]);
    expect(runKinds(h, t)).toEqual(["plan:succeeded", "work:failed"]);
  });

  test("an older app's autoComplete false is ignored: approving still completes", async () => {
    const h = setup();
    const p = h.orch.updateProject(h.project.id, { autoComplete: false } as never);
    expect(p).not.toHaveProperty("autoComplete");
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
  });

  test("complete requires review; skipAgent marks done without a run; drag to done runs nothing", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    await h.orch.idle();
    await expect(h.orch.completeTicket(t.key)).rejects.toThrow(/must be in review/);
    const done = await h.orch.completeTicket(t.key, { skipAgent: true });
    expect(done.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["plan:succeeded"]);

    const u = await h.orch.createTicket({ projectId: h.project.id, spec: "y", start: false });
    await h.orch.idle();
    const dragged = await h.orch.updateTicket(u.key, { status: "done" });
    expect(dragged.status).toBe("done");
    expect(runKinds(h, u)).toEqual(["plan:succeeded"]);
  });

  test("complete run failure stays in review with its agent review, and says why", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.driver.script = async function* () {
      yield { type: "error", message: "merge conflict" };
    };
    await h.orch.completeTicket(t.key);
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending", blockedReason: null });
    expect(h.store.activity.listBySession(cur.sessionId).at(-1)).toMatchObject({ kind: "failed", body: "Completion failed: merge conflict" });
  });

  test("cancel aborts the active run and drops queued runs; status unchanged", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "long /hold" });
    await Bun.sleep(5);
    await h.orch.sendMessage(t.key, "queued behind");
    expect(h.driver.holding).toBe(1);
    const cur = await h.orch.cancelTicket(t.key);
    expect(cur.status).toBe("in_progress");
    expect(cur.busy).toBe(false);
    await h.orch.idle();
    expect(runKinds(h, t)).toEqual(["work:cancelled", "work:cancelled"]);
    expect(h.driver.calls.length).toBe(1);
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("in_progress");
  });

  test("rerun agent review; an older app's message with move in review reopens work", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.orch.rerunAgentReview(t.key);
    await h.orch.idle();
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "review:succeeded"]);
    const cur = await h.orch.sendMessage(t.key, "one more thing", { move: true });
    expect(cur).toMatchObject({ status: "in_progress", agentReview: "pending", humanReview: "pending" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    expect(runKinds(h, t).slice(-2)).toEqual(["work:succeeded", "review:succeeded"]);
  });

  test("re-open sends a done ticket back to work with the notes; only done tickets, notes required", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await expect(h.orch.reopenTicket(t.key, { notes: "again" })).rejects.toThrow(/not done/);
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    await expect(h.orch.reopenTicket(t.key, { notes: "  " })).rejects.toThrow(/notes are required/);

    const cur = await h.orch.reopenTicket(t.key, { notes: "the button is the wrong color" });
    expect(cur.status).toBe("in_progress");
    expect(cur.completedAt).toBeNull();
    expect([cur.agentReview, cur.humanReview]).toEqual(["pending", "pending"]);
    await h.orch.idle();
    const prompt = h.driver.calls.filter((c) => c.kind === "work").at(-1)!.prompt;
    expect(prompt).toContain("re-opened");
    expect(prompt).toContain("the button is the wrong color");
    const after = h.orch.ticketDetail(t.key).ticket;
    expect(after.status).toBe("review");
    expect(after.humanReview).toBe("pending");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded", "work:succeeded", "review:succeeded"]);
    expect(statuses(h, t.sessionId)).toContain("Re-opened by human");
    expect(h.orch.activity(t.key).map((s) => `${s.kind}:${s.author}:${s.body}`)).toContain("reopened:human:the button is the wrong color");
  });

  test("dragging a done ticket to in progress re-opens it with the plan", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "the plan" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    const cur = await h.orch.updateTicket(t.key, { status: "in_progress" });
    expect(cur.status).toBe("in_progress");
    expect(cur.humanReview).toBe("pending");
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "work").at(-1)!.prompt).toContain("the plan");
    expect(statuses(h, t.sessionId)).toContain("Re-opened: moved to in progress");
  });

  test("only moving to done suspends the ticket's browser tabs", async () => {
    const h = setup();
    const suspendedTabs = (h.browser as any).suspendedTabs as string[];
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x /block which db?" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("blocked");
    await h.orch.sendMessage(t.key, "postgres /submit");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    h.orch.humanReview(t.key, { decision: "request_changes", notes: "rename it" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    // Started, blocked, unblocked, submitted twice, sent back: the tabs stay for the human to look at.
    expect(suspendedTabs).toEqual([]);

    await h.orch.completeTicket(t.key);
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(suspendedTabs).toEqual([t.sessionId]);

    // Re-opening doesn't close anything (there's nothing left); done again closes the new run's tabs.
    await h.orch.reopenTicket(t.key, { notes: "again" });
    await h.orch.idle();
    expect(suspendedTabs).toEqual([t.sessionId]);
    await h.orch.completeTicket(t.key, { skipAgent: true });
    expect(suspendedTabs).toEqual([t.sessionId, t.sessionId]);

    // A drag to done from planning closes tabs too; deleting still forgets the session.
    const u = await h.orch.createTicket({ projectId: h.project.id, spec: "y", start: false });
    await h.orch.idle();
    expect(suspendedTabs).not.toContain(u.sessionId);
    await h.orch.updateTicket(u.key, { status: "done" });
    expect(suspendedTabs.at(-1)).toBe(u.sessionId);
    await h.orch.deleteTicket(u.key);
    expect((h.browser as any).closed).toEqual([u.sessionId]);
    await h.orch.idle();
  });

  test("external keys, duplicates and validation", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "mirror", key: "foo-123", start: false });
    expect(t.key).toBe("FOO-123");
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "again", key: "FOO-123" })).rejects.toMatchObject({ status: 409 });
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "bad", key: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "x", driver: "missing" })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "x", dependsOn: ["ACME-77"] })).rejects.toMatchObject({ status: 400 });
    const n = await h.orch.createTicket({ projectId: h.project.id, spec: "native", start: false });
    expect(n.key).toBe("ACME-1");
    expect(n.title).toBe("native");
    await h.orch.idle();
  });

  test("delete removes ticket + session and closes the browser tab", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x /hold" });
    await Bun.sleep(5);
    await h.orch.deleteTicket(t.key);
    await h.orch.idle();
    expect(h.store.tickets.getByKey(t.key)).toBeNull();
    expect(h.store.sessions.get(t.sessionId)).toBeNull();
    expect((h.browser as any).closed).toEqual([t.sessionId]);
    expect(h.events.some((e) => e.kind === "ticket.deleted" && e.id === t.id)).toBe(true);
  });

  test("events: ticket.upserted busy flips and transcript.delta streams", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const busyFlags = h.events.filter((e) => e.kind === "ticket.upserted" && e.ticket.id === t.id).map((e) => (e as any).ticket.busy);
    expect(busyFlags).toContain(true);
    expect(busyFlags.at(-1)).toBe(false);
    const deltas = h.events.filter((e) => e.kind === "transcript.delta").map((e) => (e as any).text);
    expect(deltas.join("")).toBe("Hello from fake");
    // deltas are never persisted
    expect(h.store.transcript.list(t.sessionId).some((e) => e.content.type === "text" && e.content.text === "Hello")).toBe(false);
  });
});

describe("skipping the agent review", () => {
  test("a ticket created with skipAgentReview goes to review without a review run and waits only on the human", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "What does this repo do?", skipAgentReview: true });
    expect(t.skipAgentReview).toBe(true);
    await h.orch.idle();
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.agentReview, cur.humanReview]).toEqual(["review", "skipped", "pending"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded"]);
    expect(statuses(h, t.sessionId)).toContain("Agent review: skipped");

    // The human's approval is the only one left: auto-complete finishes it.
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "complete:succeeded"]);
    expect(statuses(h, t.sessionId)).toContain("Both reviews approved: completing automatically");
  });

  test("changes requested by the human come back skipped again on the next submit", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
    await h.orch.idle();
    const back = h.orch.humanReview(t.key, { decision: "request_changes", notes: "more" });
    expect([back.status, back.agentReview]).toEqual(["in_progress", "pending"]);
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.agentReview).toBe("skipped");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "work:succeeded"]);
  });

  test("with the project skipping the human review, a skipped agent review completes the ticket at once", async () => {
    const h = setup({ skipHumanReview: true });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.agentReview, cur.humanReview]).toEqual(["done", "skipped", "approved"]);
    expect(statuses(h, t.sessionId)).toContain("Both reviews approved: completing automatically");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "complete:succeeded"]);
  });

  test("the agent can skip its own review with submit_for_review skip_agent_review", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "hello /skipreview" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.agentReview, cur.skipAgentReview]).toEqual(["review", "skipped", true]);
    expect(runKinds(h, t)).toEqual(["work:succeeded"]);
    expect(statuses(h, t.sessionId)).toContain("The agent turned off the agent review for this ticket");
  });

  test("an agent can skip the agent review of a ticket that skips its human review, and it lands unreviewed", async () => {
    const h = setup({ skipHumanReview: true });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "hello /skipreview" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.agentReview, cur.skipAgentReview, cur.skipHumanReview]).toEqual(["done", "skipped", true, true]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "complete:succeeded"]);
  });

  test("turning skipAgentReview on while the agent review runs stops it; turning it off starts one", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]" });
    while (h.driver.holding === 0) await Bun.sleep(1);
    expect(h.orch.ticketDetail(t.key).ticket.agentReview).toBe("pending");

    let cur = await h.orch.updateTicket(t.key, { skipAgentReview: true });
    expect([cur.status, cur.agentReview, cur.skipAgentReview]).toEqual(["review", "skipped", true]);
    await h.orch.idle();
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:cancelled"]);
    expect(h.orch.ticketDetail(t.key).ticket.agentReview).toBe("skipped");
    h.driver.release(); // drop the aborted run's hold

    cur = await h.orch.updateTicket(t.key, { skipAgentReview: false });
    expect(cur.agentReview).toBe("pending");
    while (h.driver.holding === 0) await Bun.sleep(1);
    h.driver.release();
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.agentReview).toBe("approved");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:cancelled", "review:succeeded"]);
  });

  test("skipAgentReview must be a boolean", async () => {
    const h = setup();
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: "yes" as never })).rejects.toThrow(/skipAgentReview must be true or false/);
  });

  test("a conductor's child created with skip_agent_review is reviewed and completed by the conductor alone", async () => {
    const h = setup();
    const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "- Answer a question [skip-review]", kind: "conductor" });
    await h.orch.idle();
    const [child] = h.store.tickets.list({ parentId: parent.id });
    expect(child!.skipAgentReview).toBe(true);
    expect(child!.status).toBe("done");
    expect(runKinds(h, child!)).toEqual(["work:succeeded", "complete:succeeded"]);
  });
});

describe("skipping the human review", () => {
  test("a ticket created with skipHumanReview lands as soon as its agent review approves it", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", skipHumanReview: true });
    expect(t.skipHumanReview).toBe(true);
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.agentReview, cur.humanReview]).toEqual(["done", "approved", "approved"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
    expect(statuses(h, t.sessionId)).toContain("Human review: skipped");
    expect(statuses(h, t.sessionId)).not.toContain("Human review: approved");
  });

  test("the human can still send it back while the agent review runs", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]", skipHumanReview: true });
    while (h.driver.holding === 0) await Bun.sleep(1);
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "pending", humanReview: "approved" });
    // The human can still step in and send it back before it lands.
    const back = h.orch.humanReview(t.key, { decision: "request_changes", notes: "not yet" });
    expect([back.status, back.humanReview]).toEqual(["in_progress", "pending"]);
    h.driver.release();
    // The reworked submit skips the human review again, so it lands once the next review passes.
    while (h.driver.holding === 0) await Bun.sleep(1);
    h.driver.release();
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
  });

  test("with both reviews skipped the ticket lands as soon as it's submitted", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", skipAgentReview: true, skipHumanReview: true });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.agentReview, cur.humanReview]).toEqual(["done", "skipped", "approved"]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "complete:succeeded"]);
    expect(statuses(h, t.sessionId)).toEqual(expect.arrayContaining(["Agent review: skipped", "Human review: skipped", "Both reviews approved: completing automatically"]));
  });

  test("the agent can skip the human review with submit_for_review skip_human_review", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "ship it /skiphuman" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.skipHumanReview]).toEqual(["done", true]);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
    expect(statuses(h, t.sessionId)).toContain("The agent turned off the human review for this ticket");
  });

  test("an agent can skip both reviews at submit, or the human review of a ticket that skips its agent review, and it lands", async () => {
    const h = setup();
    const both = await h.orch.createTicket({ projectId: h.project.id, spec: "ship it /skipreview /skiphuman" });
    const noBot = await h.orch.createTicket({ projectId: h.project.id, spec: "ship it /skiphuman", skipAgentReview: true });
    await h.orch.idle();
    for (const t of [both, noBot]) {
      const cur = h.orch.ticketDetail(t.key).ticket;
      expect([cur.status, cur.agentReview, cur.humanReview, cur.skipAgentReview, cur.skipHumanReview]).toEqual(["done", "skipped", "approved", true, true]);
      // No review run: the work went straight to completion.
      expect(runKinds(h, t)).toEqual(["work:succeeded", "complete:succeeded"]);
      expect(statuses(h, t.sessionId)).toContain("The agent turned off the human review for this ticket");
    }
    expect(statuses(h, both.sessionId)).toContain("The agent turned off the agent review for this ticket");
  });

  test("turning skipHumanReview on while the ticket waits on the human lands it", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
    await h.orch.updateTicket(t.key, { skipHumanReview: true });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
  });

  test("turning it off while the agent review runs puts the human review back to pending", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]" });
    while (h.driver.holding === 0) await Bun.sleep(1);
    let cur = await h.orch.updateTicket(t.key, { skipHumanReview: true });
    expect([cur.agentReview, cur.humanReview]).toEqual(["pending", "approved"]);
    cur = await h.orch.updateTicket(t.key, { skipHumanReview: false });
    expect([cur.agentReview, cur.humanReview]).toEqual(["pending", "pending"]);
    h.driver.release();
    await h.orch.idle();
    // The agent review passed, and the ticket waits on the human like any other.
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
    expect(statuses(h, t.sessionId)).toContain("Human review: waiting on a human again");
  });

  test("a create that leaves the review switches out takes the project's defaults, and one that sets them wins", async () => {
    const h = setup({ skipAgentReview: true, skipHumanReview: true });
    const defaulted = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    const reviewed = await h.orch.createTicket({ projectId: h.project.id, spec: "y", skipAgentReview: false, skipHumanReview: false });
    expect([defaulted.skipAgentReview, defaulted.skipHumanReview, reviewed.skipAgentReview, reviewed.skipHumanReview]).toEqual([true, true, false, false]);
    await h.orch.idle();
    // Skipping both, it lands as soon as it's submitted; the other gets both reviews, like any ticket.
    expect(runKinds(h, defaulted)).toEqual(["work:succeeded", "complete:succeeded"]);
    expect(h.orch.ticketDetail(reviewed.key).ticket).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
    expect(statuses(h, reviewed.sessionId)).not.toContain("Human review: skipped");

    // The defaults are only for new tickets: changing them leaves existing ones alone.
    h.orch.updateProject(h.project.id, { skipAgentReview: false, skipHumanReview: false });
    expect(h.orch.ticketDetail(defaulted.key).ticket).toMatchObject({ skipAgentReview: true, skipHumanReview: true });
    const after = await h.orch.createTicket({ projectId: h.project.id, spec: "z", start: false });
    expect([after.skipAgentReview, after.skipHumanReview]).toEqual([false, false]);
  });

  test("project review defaults: older apps' requireHumanReview maps onto skipHumanReview, and a bad value is refused", async () => {
    const h = setup();
    expect(h.project).toMatchObject({ skipAgentReview: false, skipHumanReview: false, requireHumanReview: true });
    expect(h.orch.updateProject(h.project.id, { requireHumanReview: false })).toMatchObject({ skipHumanReview: true, requireHumanReview: false });
    // The new field wins when both come.
    expect(h.orch.updateProject(h.project.id, { requireHumanReview: false, skipHumanReview: false }).skipHumanReview).toBe(false);
    expect(() => h.orch.updateProject(h.project.id, { skipAgentReview: "yes" as never })).toThrow(/skipAgentReview must be true or false/);
  });

  test("skipHumanReview must be a boolean", async () => {
    const h = setup();
    await expect(h.orch.createTicket({ projectId: h.project.id, spec: "x", skipHumanReview: 1 as never })).rejects.toThrow(/skipHumanReview must be true or false/);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    await expect(h.orch.updateTicket(t.key, { skipHumanReview: "on" as never })).rejects.toThrow(/skipHumanReview must be true or false/);
  });

  test("a conductor's child that skips the human review lands without the conductor's approval", async () => {
    const h = setup();
    const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "- Ship the fix [skip-human]", kind: "conductor" });
    await h.orch.idle();
    const [child] = h.store.tickets.list({ parentId: parent.id });
    expect(child!.skipHumanReview).toBe(true);
    expect(child!.status).toBe("done");
    expect(runKinds(h, child!)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
    expect(statuses(h, child!.sessionId)).not.toContain("Conductor review: approved");
  });
});

describe("messages that leave the ticket where it is (chat runs)", () => {
  test("in review: the agent answers with its work tools, and the ticket keeps its status and reviews", async () => {
    const h = setup({ realTools: true });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    const before = h.orch.ticketDetail(t.key).ticket;
    expect(before).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });

    const cur = await h.orch.sendMessage(t.key, "why a button?");
    expect(cur.status).toBe("review");
    expect(cur.busy).toBe(true);
    await h.orch.idle();
    const after = h.orch.ticketDetail(t.key).ticket;
    expect(after).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending", blockedReason: null });
    // No new work or review run.
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "chat:succeeded"]);
    const chat = h.driver.calls.at(-1)!;
    expect(chat.kind).toBe("chat");
    // Only a blocked ticket's message carries the unblock note.
    expect(chat.prompt).toBe("why a button?");
    expect(chat.permissionMode).not.toBe("read_only");
    // The submit moved the card, so the chat starts fresh (not the work's or the reviewer's
    // conversation), and saves its own for the next chat in review.
    expect(chat.state).toBeNull();
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 1 });
    expect(chat.toolNames).toEqual(h.driver.calls[0]!.toolNames);
    expect(h.orch.activity(t.key).some((s) => s.kind === "blocked")).toBe(false);
    // The exchange is in the transcript only: neither the question nor the answer goes into Activity.
    expect(h.orch.activity(t.key).filter((s) => s.kind === "message" || s.kind === "answer")).toEqual([]);
    expect(lastText(h, t.sessionId)).toBe("Chatting about: why a button?.");
  });

  test("in review: a chat that changed the work submits again, and the reviews start over with one reviewer", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "make it red /hold /submit");
    await Bun.sleep(5);
    // A review queued behind the chat is dropped when the chat submits: the new one replaces it.
    h.orch.rerunAgentReview(t.key);
    h.driver.release();
    await h.orch.idle();
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "chat:succeeded", "review:cancelled", "review:succeeded"]);
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
    expect(h.orch.activity(t.key).filter((s) => s.body === "Done from chat.")).toHaveLength(1);
  });

  test("in review: resume_work moves the ticket to in progress while the chat changes it, then it ends like a work run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved" });
    await h.orch.sendMessage(t.key, "make it red /resume /hold");
    await Bun.sleep(5);
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "in_progress", agentReview: "pending", humanReview: "pending" });
    expect(h.store.transcript.list(t.sessionId).some((e) => e.content.type === "status" && e.content.text === "Moved back to in progress by the agent: changing it")).toBe(true);
    h.driver.release();
    await h.orch.idle();
    // Left in progress, the chat auto-submits like a work run, and a fresh agent review judges the new work.
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "chat:succeeded", "review:succeeded"]);
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
  });

  test("resume_work keeps the chat's conversation: a block resumes it, and the next submit drops it", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "make it red /resume /block Which red?");
    await h.orch.idle();
    // The chat ran on in progress (no restart), and its conversation is the in-progress session.
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "chat:succeeded"]);
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "blocked", blockedReason: "Which red?" });
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 1 });
    await h.orch.sendMessage(t.key, "crimson /unblock /submit");
    await h.orch.idle();
    const chats = h.driver.calls.filter((c) => c.kind === "chat");
    expect(chats.map((c) => c.state)).toEqual([null, { turns: 1 }]);
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    // The submit moved the card: the next chat starts fresh.
    await h.orch.sendMessage(t.key, "done?");
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "chat").at(-1)!.state).toBeNull();
  });

  test("resume_work from a done chat keeps the chat's conversation for the next run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    await h.orch.sendMessage(t.key, "one more thing");
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "fix it /resume /block Which file?");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("blocked");
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 2 });
    await h.orch.sendMessage(t.key, "a.ts /unblock /submit");
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "chat").map((c) => c.state)).toEqual([null, { turns: 1 }, { turns: 2 }]);
  });

  test("resume_work is refused on a ticket that isn't in review or done", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "Postgres /resume");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "blocked", blockedReason: "Which database?" });
    expect(lastText(h, t.sessionId)).toContain(`Refused: ${t.key} is blocked, not in review or done`);
  });

  test("in done: resume_work re-opens the ticket while the chat works, then it ends like a work run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    await h.orch.sendMessage(t.key, "check Miami again /resume /hold");
    await Bun.sleep(5);
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "in_progress", agentReview: "pending", humanReview: "pending" });
    expect(h.orch.activity(t.key).at(-1)).toMatchObject({ kind: "reopened", author: "agent", body: "changing it", meta: { from: "done", to: "in_progress" } });
    h.driver.release();
    await h.orch.idle();
    // Left in progress, the chat auto-submits, and the agent review judges the new round.
    expect(runKinds(h, t).slice(-2)).toEqual(["chat:succeeded", "review:succeeded"]);
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
  });

  test("in review: block asks the human and starts the reviews over", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "change the copy /block Which copy?");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "blocked", blockedReason: "Which copy?", agentReview: "pending", humanReview: "pending" });
    // The blocked entry is the answer: the chat's last text isn't posted as well.
    expect(h.orch.activity(t.key).at(-1)).toMatchObject({ kind: "blocked", author: "agent", body: "Which copy?" });
  });

  test("in blocked: a side question leaves the ticket blocked with its question open", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "what are the options? /ask");
    await h.orch.idle();
    // No unblock: no auto-block on the trailing question and no auto-submit either.
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "blocked", blockedReason: "Which database?" });
    expect(runKinds(h, t)).toEqual(["work:succeeded", "chat:succeeded"]);
    expect(h.orch.activity(t.key).at(-1)).toMatchObject({ kind: "blocked", body: "Which database?" });
    expect(lastText(h, t.sessionId)).toBe("Which color should it be?");
  });

  test("in blocked: once the agent unblocks, the chat ends like a work run (auto-submit, or block on a question)", async () => {
    const h = setup();
    const a = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    await h.orch.sendMessage(a.key, "Postgres /unblock");
    await h.orch.idle();
    expect(h.orch.ticketDetail(a.key).ticket).toMatchObject({ status: "review", blockedReason: null });
    expect(h.orch.activity(a.key).find((s) => s.kind === "submitted")).toMatchObject({ author: "system", body: "Chatting about: Postgres /unblock." });

    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    await h.orch.sendMessage(b.key, "Postgres /unblock /ask");
    await h.orch.idle();
    expect(h.orch.ticketDetail(b.key).ticket).toMatchObject({ status: "blocked", blockedReason: "Which color should it be?" });
  });

  test("in blocked: block replaces the question; unblock is refused on a ticket that isn't blocked", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "Postgres /block Which port?");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "blocked", blockedReason: "Which port?" });

    const r = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.sendMessage(r.key, "looks good /unblock");
    await h.orch.idle();
    expect(h.orch.ticketDetail(r.key).ticket.status).toBe("review");
    expect(lastText(h, r.sessionId)).toContain(`Refused: ${r.key} is review, not blocked`);
  });

  test("a blocked ticket without a worktree gets one before the chat; its status doesn't change", async () => {
    const h = setup();
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const p = h.orch.createProject({ path: repo, key: "repo" });
    const t = await h.orch.createTicket({ projectId: p.id, spec: "x", start: false });
    await h.orch.idle();
    // Dragged from planning to blocked: it never got a worktree.
    await h.orch.updateTicket(t.key, { status: "blocked" });
    expect(h.orch.ticketDetail(t.key).ticket.workdir).toBeNull();
    const cur = await h.orch.sendMessage(t.key, "go ahead");
    expect(cur.status).toBe("blocked");
    expect(existsSync(join(cur.workdir!, ".git"))).toBe(true);
    await h.orch.idle();
    expect(h.driver.calls.at(-1)).toMatchObject({ kind: "chat", cwd: cur.workdir });
  });

  test("in planning: the plan run takes the message, never a chat", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Refactor auth", start: false });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "is this risky?");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "planning", spec: "1. Do is this risky?" });
    expect(runKinds(h, t)).toEqual(["plan:succeeded", "plan:succeeded"]);
  });

  test("block and submit_for_review refuse a planning or done ticket", async () => {
    const h = setup();
    const refusals: string[] = [];
    h.driver.script = async function* (req) {
      for (const f of [() => req.toolContext.ops.submitForReview(req.toolContext, "x", true), () => req.toolContext.ops.block(req.toolContext, "q?")]) {
        try {
          await f();
        } catch (err) {
          refusals.push((err as Error).message);
        }
      }
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("planning");
    expect(refusals).toEqual([`${t.key} is still in planning: the work starts when the human presses Start, so submit_for_review doesn't apply yet.`, `${t.key} is still in planning: the work starts when the human presses Start, so block doesn't apply yet.`]);

    h.driver.script = null;
    const d = await h.orch.createTicket({ projectId: h.project.id, spec: "y" });
    await h.orch.idle();
    await h.orch.completeTicket(d.key, { skipAgent: true });
    await h.orch.sendMessage(d.key, "one more thing /submit");
    await h.orch.idle();
    expect(h.orch.ticketDetail(d.key).ticket.status).toBe("done");
    expect(lastText(h, d.sessionId)).toContain(`Refused: ${d.key} is done: call resume_work first to re-open it`);
  });

  test("in done: the ticket stays done; an older app's message with move re-opens it", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    expect((await h.orch.sendMessage(t.key, "what did you change?")).status).toBe("done");
    await h.orch.idle();
    expect(runKinds(h, t).at(-1)).toBe("chat:succeeded");
    // The message stays out of Activity, and so does the chat's answer to it.
    expect(h.orch.activity(t.key).filter((s) => s.kind === "message" || s.kind === "answer")).toEqual([]);
    const cur = await h.orch.sendMessage(t.key, "change it back", { move: true });
    expect(cur).toMatchObject({ status: "in_progress", agentReview: "pending", humanReview: "pending" });
  });

  test("a failed chat leaves the ticket where it is, unless it had unblocked the ticket", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.driver.script = async function* (req) {
      if (req.kind !== "chat") return;
      if (req.prompt.includes("/unblock")) await req.toolContext.ops.unblock(req.toolContext);
      yield { type: "error", message: "boom" };
    };
    await h.orch.sendMessage(t.key, "hello");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "chat:failed"]);
    expect(h.orch.activity(t.key).at(-1)).toMatchObject({ author: "system", kind: "failed", body: "Run failed: boom" });

    h.driver.script = null;
    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    h.driver.script = async function* (req) {
      if (req.kind !== "chat") return;
      await req.toolContext.ops.unblock(req.toolContext);
      yield { type: "error", message: "crashed mid-work" };
    };
    await h.orch.sendMessage(b.key, "Postgres");
    await h.orch.idle();
    // It was working (in progress) when it failed: blocked with the error, like a failed work run.
    expect(h.orch.ticketDetail(b.key).ticket).toMatchObject({ status: "blocked", blockedReason: "crashed mid-work" });
  });

  test("a chat's approval card leaves the ticket in its column, and answering it resumes the chat", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.store.tickets.update(t.id, { permissionMode: "ask" });
    await h.orch.sendMessage(t.key, 'clean it /tool Bash {"command":"rm -rf dist"}');
    await h.orch.idle();
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur).toMatchObject({ status: "review", agentReview: "approved", pendingApproval: { toolName: "Bash" }, blockedReason: null });
    expect(h.driver.approvals.at(-1)).toEqual({ name: "Bash", behavior: "deny" });

    cur = await h.orch.answerApproval(t.key, { decision: "allow_once" });
    expect(cur).toMatchObject({ status: "review", pendingApproval: null });
    await h.orch.idle();
    // The retry is a chat with the one-time grant, and the ticket is still in review.
    const retry = h.driver.calls.at(-1)!;
    expect(retry.kind).toBe("chat");
    expect(retry.grants?.once).toEqual([{ toolName: "Bash", input: { command: "rm -rf dist" } }]);
    expect(h.driver.approvals.at(-1)).toEqual({ name: "Bash", behavior: "allow" });
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved" });
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "chat:succeeded", "chat:succeeded"]);
  });

  test("a blocked ticket's chat approval keeps its question, and unblock waits for the human's answer", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    h.store.tickets.update(t.id, { permissionMode: "ask" });
    let refused = "";
    h.driver.script = async function* (req) {
      if (req.kind !== "chat") return;
      await req.toolContext.ops.requestApproval(req.toolContext, "Bash", { command: "psql -c 'create database x'" });
      try {
        await req.toolContext.ops.unblock(req.toolContext);
      } catch (err) {
        refused = (err as Error).message;
      }
    };
    await h.orch.sendMessage(t.key, "Postgres");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "blocked", blockedReason: "Which database?", pendingApproval: { toolName: "Bash" } });
    expect(refused).toContain("waiting on a human to answer a tool approval (Bash)");
    // A message now answers the approval (a deny), and the chat resumes: the question is still open.
    h.driver.script = null;
    await h.orch.sendMessage(t.key, "no, use sqlite");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "blocked", blockedReason: "Which database?", pendingApproval: null });
    expect(h.driver.calls.at(-1)!.kind).toBe("chat");
    expect(h.driver.calls.at(-1)!.prompt).toContain("The human denied Bash");
  });

  test("runs with the ticket's permission mode and all of its grants", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.store.tickets.update(t.id, { permissionMode: "ask", allowedTools: ["WebFetch"] });
    h.store.tickets.addGrant(t.id, "Bash", { command: "npm publish" });
    h.driver.script = async function* (req) {
      if (req.kind !== "chat") return;
      // Native calls are gated with the ticket's mode, not read_only: an edit in the workdir runs.
      const edit = await req.toolContext.ops.checkPermission(req.toolContext, "Edit", { file_path: join(req.cwd, "a.ts"), old_string: "a", new_string: "b" });
      yield { type: "text", text: `edit:${edit.behavior}` };
    };
    await h.orch.sendMessage(t.key, "can you clean dist?");
    await h.orch.idle();
    const chat = h.driver.calls.at(-1)!;
    expect(chat.kind).toBe("chat");
    expect(chat.permissionMode).toBe("ask");
    expect(chat.grants).toEqual({ tools: ["WebFetch"], once: [{ toolName: "Bash", input: { command: "npm publish" } }] });
    expect(lastText(h, t.sessionId)).toBe("edit:allow");
  });

  test("a read_only ticket's chat stays read-only", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    h.store.tickets.update(t.id, { permissionMode: "read_only", allowedTools: ["WebFetch"] });
    await h.orch.sendMessage(t.key, "hi");
    await h.orch.idle();
    expect(h.driver.calls.at(-1)).toMatchObject({ kind: "chat", permissionMode: "read_only", grants: undefined });
  });

  test("a done ticket whose worktree is gone chats from the project checkout", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    h.store.tickets.update(t.id, { workdir: join(h.home, "gone") });
    await h.orch.sendMessage(t.key, "what did you change?");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(h.driver.calls.at(-1)).toMatchObject({ kind: "chat", cwd: h.project.path });
    expect(runKinds(h, t).at(-1)).toBe("chat:succeeded");
  });

  test("a done ticket chats from the checkout when its session still points at the removed worktree", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    // What a real worktree leaves behind: the ticket and its session both named it.
    const gone = join(h.home, "worktrees", t.key);
    h.store.tickets.update(t.id, { workdir: gone });
    h.store.sessions.update(t.sessionId, { cwd: gone });
    await h.orch.sendMessage(t.key, "what did you change?");
    await h.orch.idle();
    expect(h.driver.calls.at(-1)).toMatchObject({ kind: "chat", cwd: h.project.path });
    expect(runKinds(h, t).at(-1)).toBe("chat:succeeded");
  });

  test("refused while the ticket is completing; text is required", async () => {
    const h = setup();
    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "y" });
    await h.orch.idle();
    h.driver.script = async function* () {
      await Bun.sleep(20);
    };
    await h.orch.completeTicket(b.key);
    await expect(h.orch.sendMessage(b.key, "wait")).rejects.toThrow(/is completing/);
    await expect(h.orch.sendMessage(b.key, "  ")).rejects.toThrow(/text is required/);
    await h.orch.idle();
  });
});

describe("scheduling", () => {
  test("dependsOn + autoStart: dependent starts when its dependency is done", async () => {
    const h = setup();
    const a = await h.orch.createTicket({ projectId: h.project.id, spec: "A" });
    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "B", start: false, autoStart: true, dependsOn: [a.key] });
    expect(b.status).toBe("planning");
    await h.orch.idle();
    expect(h.orch.ticketDetail(b.key).ticket.status).toBe("planning");
    expect(runKinds(h, b)).toEqual([]); // waiting, no plan run
    expect(h.orch.ticketDetail(a.key).dependents).toEqual([b.key]);

    await h.orch.completeTicket(a.key, { skipAgent: true });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(b.key).ticket;
    expect(cur.status).toBe("review");
    expect(runKinds(h, b)[0]).toBe("work:succeeded");
  });

  test("dependents without autoStart are not started; start:true with open deps waits", async () => {
    const h = setup();
    const a = await h.orch.createTicket({ projectId: h.project.id, spec: "A", start: false });
    const manual = await h.orch.createTicket({ projectId: h.project.id, spec: "B", start: false, dependsOn: [a.key] });
    const eager = await h.orch.createTicket({ projectId: h.project.id, spec: "C", start: true, dependsOn: [a.key] });
    expect(eager.status).toBe("planning");
    expect(eager.autoStart).toBe(true);
    await h.orch.idle();
    await h.orch.updateTicket(a.key, { status: "done" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(manual.key).ticket.status).toBe("planning");
    expect(h.orch.ticketDetail(eager.key).ticket.status).toBe("review");
  });

  test("Start on a planned ticket with an open dependency queues it: planning, autoStart, started once the dependency is done", async () => {
    const h = setup();
    const statusLines = (t: Ticket) => h.store.transcript.tail(t.sessionId, 50, ["status"]).map((e) => ("text" in e.content ? e.content.text : ""));
    const a = await h.orch.createTicket({ projectId: h.project.id, spec: "A", start: false });
    const b = await h.orch.createTicket({ projectId: h.project.id, spec: "B", start: false });
    await h.orch.idle();
    expect(runKinds(h, b)).toEqual(["plan:succeeded"]);
    await h.orch.updateTicket(b.key, { dependsOn: [a.key] }); // the dependency added after planning

    const queued = await h.orch.startTicket(b.key);
    expect([queued.status, queued.autoStart]).toEqual(["planning", true]);
    expect(statusLines(b).at(-1)).toBe(`Waiting on ${a.key}`);
    // Start again while it waits: nothing changes, no second status line.
    const lines = statusLines(b).length;
    expect((await h.orch.startTicket(b.key)).status).toBe("planning");
    expect(statusLines(b).length).toBe(lines);
    await h.orch.idle();
    expect(runKinds(h, b)).toEqual(["plan:succeeded"]); // no work run yet

    await h.orch.updateTicket(a.key, { status: "done" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(b.key).ticket.status).toBe("review");
    expect(runKinds(h, b).slice(0, 2)).toEqual(["plan:succeeded", "work:succeeded"]);
  });

  test("Start ignores dependencies that are done or deleted, and doesn't hold a blocked ticket", async () => {
    const h = setup();
    const done = await h.orch.createTicket({ projectId: h.project.id, spec: "done", start: false });
    await h.orch.updateTicket(done.key, { status: "done" });
    const gone = await h.orch.createTicket({ projectId: h.project.id, spec: "gone", start: false });
    const open = await h.orch.createTicket({ projectId: h.project.id, spec: "open", start: false });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "t", start: false, dependsOn: [done.key, gone.key] });
    await h.orch.idle();
    await h.orch.deleteTicket(gone.key);
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");

    const blocked = await h.orch.createTicket({ projectId: h.project.id, spec: "x /block why?" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(blocked.key).ticket.status).toBe("blocked");
    await h.orch.updateTicket(blocked.key, { dependsOn: [open.key] });
    await h.orch.startTicket(blocked.key);
    expect(h.orch.ticketDetail(blocked.key).ticket.status).toBe("in_progress");
  });
});

describe("concurrency", () => {
  test("runs are serialized per session", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "a /hold /nosubmit" });
    await h.orch.sendMessage(t.key, "b /hold /nosubmit");
    await Bun.sleep(10);
    expect(h.driver.running).toBe(1);
    h.driver.release();
    await Bun.sleep(10);
    expect(h.driver.running).toBe(1);
    h.driver.release();
    await h.orch.idle();
    expect(h.driver.maxRunning).toBe(1);
  });

  test("global maxConcurrentRuns limit, raised live via settings", async () => {
    const h = setup();
    h.orch.updateSettings({ maxConcurrentRuns: 2 });
    for (let i = 0; i < 5; i++) await h.orch.createTicket({ projectId: h.project.id, spec: `t${i} /hold` });
    await Bun.sleep(10);
    expect(h.driver.running).toBe(2);
    h.orch.updateSettings({ maxConcurrentRuns: 3 });
    await Bun.sleep(10);
    expect(h.driver.running).toBe(3);
    while (h.driver.holding || h.driver.running) {
      h.driver.release();
      await Bun.sleep(2);
    }
    await h.orch.idle();
    expect(h.driver.maxRunning).toBe(3);
  });
});

describe("conductor", () => {
  test("creates children, is notified of their changes, approves + completes them, then submits", async () => {
    const h = setup();
    const c = await h.orch.createTicket({ projectId: h.project.id, spec: "Big job\n- Build API\n- Build UI", kind: "conductor" });
    await h.orch.idle(20_000);
    const d = h.orch.ticketDetail(c.key);
    expect(d.children.map((x) => x.title)).toEqual(["Build API", "Build UI"]);
    for (const child of d.children) {
      expect(child.parentId).toBe(c.id);
      expect(child.autoStart).toBe(true);
      expect(child.status).toBe("done");
      expect(child.humanReview).toBe("approved");
    }
    expect(d.ticket.status).toBe("review");
    const conductorPrompts = h.driver.calls.filter((x) => x.kind === "conductor").map((x) => x.prompt);
    expect(conductorPrompts[0]).toContain("- Build API");
    expect(conductorPrompts.slice(1).some((p) => p.includes("review → done"))).toBe(true);
    expect(conductorPrompts.slice(1).some((p) => p.includes("in_progress → review"))).toBe(true);
  });

  test("child changes while the conductor is busy coalesce into one conductor run", async () => {
    const h = setup();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const keys: string[] = [];
    h.driver.script = async function* (req) {
      if (req.kind !== "conductor") return;
      if (!keys.length) {
        for (const title of ["a", "b"]) {
          keys.push((await req.toolContext.ops.createTicket(req.toolContext, { title, spec: title, autoStart: false })).key);
        }
        await gate;
      }
    };
    const c = await h.orch.createTicket({ projectId: h.project.id, spec: "go", kind: "conductor" });
    while (keys.length < 2) await Bun.sleep(2);
    await h.orch.updateTicket(keys[0]!, { status: "blocked" });
    await h.orch.updateTicket(keys[1]!, { status: "done" });
    open();
    await h.orch.idle();
    const conductorRuns = h.driver.calls.filter((x) => x.kind === "conductor");
    expect(conductorRuns.length).toBe(2);
    expect(conductorRuns[1]!.prompt).toContain(`${keys[0]} "a": planning → blocked`);
    expect(conductorRuns[1]!.prompt).toContain(`${keys[1]} "b": planning → done`);
    // one child still open → the conductor stays in progress (no auto-submit)
    expect(h.orch.ticketDetail(c.key).ticket.status).toBe("in_progress");
  });

  test("a conductor's approval doesn't auto-complete its child: complete_ticket stays the conductor's call", async () => {
    const h = setup();
    const keys: string[] = [];
    h.driver.script = async function* (req) {
      const ops = req.toolContext.ops;
      if (req.kind === "work") return void (await ops.submitForReview(req.toolContext, "done", true));
      if (req.kind === "review") return void (await ops.reviewDecision(req.toolContext, "approve", ""));
      if (req.kind !== "conductor") return;
      if (!keys.length) {
        keys.push((await ops.createTicket(req.toolContext, { title: "only", spec: "only", autoStart: true })).key);
        return;
      }
      const child = (await ops.getTicket(req.toolContext, keys[0]!)).ticket;
      if (child.status === "review" && child.agentReview === "approved" && child.humanReview === "pending") {
        await ops.reviewTicket(req.toolContext, child.key, "approve", "");
      }
    };
    await h.orch.createTicket({ projectId: h.project.id, spec: "go", kind: "conductor" });
    await h.orch.idle();
    const child = h.orch.ticketDetail(keys[0]!).ticket;
    expect([child.status, child.agentReview, child.humanReview]).toEqual(["review", "approved", "approved"]);
    expect(runKinds(h, child)).toEqual(["work:succeeded", "review:succeeded"]);
    expect(statuses(h, child.sessionId)).toContain("Ready to complete");

    // The conductor is marked done without landing it: the child is the human's again, and their
    // approval lands it.
    const parent = h.store.tickets.get(child.parentId!)!;
    await h.orch.completeTicket(parent.key, { skipAgent: true });
    const released = h.orch.ticketDetail(child.key).ticket;
    expect([released.status, released.humanReview]).toEqual(["review", "pending"]);
    expect(statuses(h, child.sessionId)).toContain(`${parent.key} is done: approve to land this ticket`);
    h.driver.script = null;
    h.orch.humanReview(child.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(child.key).ticket.status).toBe("done");
    expect(runKinds(h, child)).toEqual(["work:succeeded", "review:succeeded", "complete:succeeded"]);
  });

  test("conductor auto-submits when its run ends with every child done", async () => {
    const h = setup();
    const keys: string[] = [];
    h.driver.script = async function* (req) {
      if (req.kind === "conductor" && !keys.length) {
        keys.push((await req.toolContext.ops.createTicket(req.toolContext, { title: "only", spec: "only", autoStart: false })).key);
      }
    };
    const c = await h.orch.createTicket({ projectId: h.project.id, spec: "go", kind: "conductor" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(c.key).ticket.status).toBe("in_progress");
    await h.orch.updateTicket(keys[0]!, { status: "done" });
    await h.orch.idle();
    const d = h.orch.ticketDetail(c.key);
    expect(d.ticket.status).toBe("review");
    expect(d.activity.some((s) => s.author === "system")).toBe(true);
  });

  test("default conductor children chain via dependsOn", async () => {
    const h = setup();
    const c = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it all", kind: "conductor" });
    await h.orch.idle(20_000);
    const kids = h.orch.ticketDetail(c.key).children;
    expect(kids.length).toBe(2);
    expect(kids[1]!.dependsOn).toEqual([kids[0]!.key]);
    const second = h.driver.calls.find((x) => x.kind === "work" && x.prompt.includes("Second child"))!;
    const firstDone = h.store.runs.listBySession(kids[0]!.sessionId).find((r) => r.kind === "complete")!;
    // second child's work only started after the first child's completion run
    const secondRun = h.store.runs.get(second.runId)!;
    expect(secondRun.startedAt!).toBeGreaterThanOrEqual(firstDone.endedAt!);
  });

  test("a task ticket asked for a child conducts it: work runs are notified, review + complete it, then submit", async () => {
    const h = setup();
    const keys: string[] = [];
    const submitErrors: string[] = [];
    const parentPrompts: string[] = [];
    let parentKey = "";
    let submitted = false;
    h.driver.script = async function* (req) {
      const ctx = req.toolContext;
      const ops = ctx.ops;
      if (req.kind === "review") return void (await ops.reviewDecision(ctx, "approve", ""));
      if (req.kind === "complete" || req.kind === "plan") return;
      if (ctx.ticket?.key !== parentKey) return void (await ops.submitForReview(ctx, "child done", true));
      parentPrompts.push(req.prompt);
      if (!keys.length) {
        keys.push((await ops.createTicket(ctx, { title: "Rebase PR", spec: "Bring the PR up to date", child: true })).key);
        await ops.submitForReview(ctx, "too early", true).catch((e) => submitErrors.push(String(e)));
        return;
      }
      let child = (await ops.getTicket(ctx, keys[0]!)).ticket;
      if (child.status === "review" && child.agentReview === "approved" && child.humanReview === "pending") {
        await ops.reviewTicket(ctx, child.key, "approve", "looks right");
        await ops.completeTicket(ctx, child.key);
        // The child's complete run can land before this run ends, and then the run would be
        // auto-submitted with its last text. Wait for it, so the submit below is the agent's own.
        while (child.status !== "done") {
          await Bun.sleep(2);
          child = (await ops.getTicket(ctx, keys[0]!)).ticket;
        }
      }
      if (child.status === "done" && !submitted) {
        submitted = true;
        await ops.submitForReview(ctx, "the child is merged", true);
      }
    };
    const draft = await h.orch.createTicket({ projectId: h.project.id, spec: "Audit the PRs", start: false });
    parentKey = draft.key;
    await h.orch.idle();
    await h.orch.startTicket(parentKey);
    await h.orch.idle(20_000);

    const d = h.orch.ticketDetail(parentKey);
    expect(d.ticket.kind).toBe("task");
    expect(d.ticket.childCount).toBe(1);
    expect(d.children.map((c) => [c.key, c.parentId, c.autoStart, c.status, c.humanReview])).toEqual([[keys[0]!, d.ticket.id, true, "done", "approved"]]);
    expect(submitErrors[0]).toContain(`still has child tickets that aren't done (${keys[0]}:`);
    // The parent's steering runs are work runs (full tools) with the child-update prompt, and it
    // wasn't auto-submitted while the child was open.
    expect(runKinds(h, d.ticket).filter((k) => !k.startsWith("plan"))).toEqual([
      ...Array(parentPrompts.length).fill("work:succeeded"),
      "review:succeeded",
    ]);
    expect(parentPrompts.slice(1).some((p) => p.includes("Child ticket updates:") && p.includes("in_progress → review"))).toBe(true);
    expect(d.ticket.status).toBe("review");
    expect(d.activity.some((s) => s.body === "the child is merged")).toBe(true);
    // Clients learn the parent now has children from its own upsert.
    const upserts = h.events.filter((e) => e.kind === "ticket.upserted" && e.ticket.key === parentKey) as { ticket: Ticket }[];
    expect(upserts.some((e) => e.ticket.childCount === 1)).toBe(true);
  });

  test("a task ticket with children defaults list_tickets to its children; without child it files top-level tickets", async () => {
    const h = setup();
    const scopes: string[][] = [];
    let made: Ticket[] = [];
    h.driver.script = async function* (req) {
      const ctx = req.toolContext;
      if (req.kind !== "work" || ctx.ticket?.title !== "parent") return;
      made = [
        await ctx.ops.createTicket(ctx, { title: "top", spec: "x" }),
        await ctx.ops.createTicket(ctx, { title: "kid", spec: "x", child: true, autoStart: false }),
      ];
      scopes.push((await ctx.ops.listTickets(ctx, {})).tickets.map((t) => t.title));
    };
    const p = await h.orch.createTicket({ projectId: h.project.id, spec: "parent", title: "parent" });
    await h.orch.idle();
    expect(made.map((t) => [t.title, t.parentId, t.status])).toEqual([
      ["top", null, "planning"],
      ["kid", p.id, "planning"],
    ]);
    expect(scopes).toEqual([["kid"]]);
    expect(h.orch.ticketDetail(p.key).ticket.status).toBe("in_progress"); // open child → no auto-submit
    await h.orch.deleteTicket(made[1]!.key);
    expect(h.orch.ticketDetail(p.key).ticket.childCount).toBe(0);
  });

  test("review_ticket and complete_ticket reject tickets that aren't the caller's children", async () => {
    const h = setup();
    const other = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    const errs: Record<string, string[]> = {};
    h.driver.script = async function* (req) {
      const ctx = req.toolContext;
      if (ctx.ticket?.key === other.key) return;
      for (const call of [() => ctx.ops.reviewTicket(ctx, other.key, "approve", ""), () => ctx.ops.completeTicket(ctx, other.key)]) {
        await call().catch((e) => (errs[req.kind] ??= []).push(String(e)));
      }
    };
    await h.orch.idle();
    await h.orch.createTicket({ projectId: h.project.id, spec: "work" });
    await h.orch.createTicket({ projectId: h.project.id, spec: "conduct", kind: "conductor" });
    await h.orch.idle();
    // A task ticket may conduct its own children, but never someone else's.
    for (const kind of ["work", "conductor"]) {
      expect(errs[kind]!.length).toBe(2);
      expect(errs[kind]!.every((e) => e.includes(`${other.key} is not a child of`))).toBe(true);
    }
    // Their review runs can't stand in for anyone.
    expect(errs.review!.every((e) => e.includes("only available in work, conductor and chat runs"))).toBe(true);
  });
});

describe("triage", () => {
  const lastTriagePrompt = (h: ReturnType<typeof setup>) => h.driver.calls.filter((c) => c.kind === "triage").at(-1)!.prompt;

  const ROUTE = "Dispatch Jira work. [dummy:project ACME]";

  test("the watcher's prompt names the project; the output's key becomes the ticket's remote ID", async () => {
    const h = setup();
    const s = await h.orch.injectOutput("jira", { key: "FOO-123", summary: "Fix login", url: "https://x/FOO-123", updated: "1" }, ROUTE);
    expect(s!.key).toBe("TRIAGE-1");
    expect(s!.kind).toBe("triage");
    expect(s!.triageStatus).toBe("triaging");
    expect(s!.title).toBe('{"key":"FOO-123","summary":"Fix login","url":"https://x/FOO-123","updated":"1"}'); // objects arrive as one JSON line
    expect(s!.cwd).toBe(h.paths.home); // triage isn't in any project until it dispatches
    await h.orch.idle();
    const session = h.orch.getSession(s!.id);
    expect(session.triageStatus).toBe("dispatched");
    expect(session.outcome).toBe("Dispatched to ACME-1 (FOO-123) in ACME");
    expect(session.title).toBe("Work for FOO-123"); // triage's title replaces the first line
    // The ticket gets the project's next key; the remote ID is only a link, never a lookup key.
    expect(() => h.orch.ticketDetail("FOO-123")).toThrow(expect.objectContaining({ status: 404 }));
    const t = h.orch.ticketDetail("ACME-1").ticket;
    expect(t.projectId).toBe(h.project.id);
    expect(t.externalRef).toMatchObject({ source: "jira", key: "FOO-123", url: "https://x/FOO-123" });
    expect(t.status).toBe("review"); // start: true → worked → reviewed
    expect(h.orch.listSessions("triage").map((x) => x.key)).toEqual(["TRIAGE-1"]);
  });

  test("plain text with a prompt reaches the triage prompt; a prompt naming no project is declined", async () => {
    const h = setup();
    const s = await h.orch.injectOutput("status", "  Deploy failed on staging\nsee logs  \n", "Only failures on production matter.");
    expect(s!.title).toBe("Deploy failed on staging");
    const prompt = lastTriagePrompt(h);
    expect(prompt).toContain("Deploy failed on staging\nsee logs");
    expect(prompt).toContain("Only failures on production matter.");
    expect(prompt).toContain("Pick the project from the human's prompt and the output.");
    await h.orch.idle();
    expect(h.orch.getSession(s!.id).triageStatus).toBe("declined");
    expect(h.orch.getSession(s!.id).outcome).toMatch(/^Declined: /);
  });

  test("identical output is triaged once per source; changed output is triaged again", async () => {
    const h = setup();
    expect(await h.orch.injectOutput("jira", "BAR-1 changed")).not.toBeNull();
    expect(await h.orch.injectOutput("jira", "\n BAR-1 changed \n")).toBeNull(); // same once trimmed
    expect(await h.orch.injectOutput("other", "BAR-1 changed")).not.toBeNull(); // another source
    const again = await h.orch.injectOutput("jira", "BAR-1 changed again");
    expect(again!.key).toBe("TRIAGE-3");
    await h.orch.idle();
  });

  test("inject validates source, text and prompt", async () => {
    const h = setup();
    await expect(h.orch.injectOutput("", "x")).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.injectOutput("jira", "   \n")).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.injectOutput("jira", undefined)).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.injectOutput("jira", "x", 5)).rejects.toMatchObject({ status: 400 });
  });

  test("oversized injected output is cut and flagged in the prompt", async () => {
    const h = setup();
    await h.orch.injectOutput("jira", "x".repeat(20_000));
    const prompt = lastTriagePrompt(h);
    expect(prompt).toContain("x".repeat(16_000));
    expect(prompt).not.toContain("x".repeat(16_001));
    expect(prompt).toContain("was cut off");
    await h.orch.idle();
  });

  test("a ticket linked to the output's key is listed for triage, and ticket_key sends it the update", async () => {
    const h = setup();
    await h.orch.injectOutput("jira", { key: "FOO-9", summary: "v1", updated: "1" }, ROUTE);
    await h.orch.idle();
    const before = h.orch.ticketDetail("ACME-1");
    expect(before.ticket.status).toBe("review");
    const s2 = await h.orch.injectOutput("jira", { key: "FOO-9", summary: "v2", updated: "2" }, `${ROUTE} [dummy:ticket ACME-1]`);
    expect(lastTriagePrompt(h)).toMatch(/## Existing tickets\n[^\n]*\n\* ACME-1 "Work for FOO-9", status review, remote ID FOO-9/);
    await h.orch.idle();
    expect(h.orch.getSession(s2!.id).outcome).toBe("Sent update to existing ACME-1");
    expect(h.orch.listTickets().length).toBe(1);
    // The update goes to the ticket's agent (a chat); the ticket stays where it was.
    const last = h.driver.calls.at(-1)!;
    expect([last.kind, last.prompt]).toEqual(["chat", "Handle FOO-9"]);
    expect(h.orch.ticketDetail("ACME-1").ticket.status).toBe("review");
    expect(h.orch.ticketDetail("ACME-1").runs.length).toBe(before.runs.length + 1);
  });

  test("dispatch without a key uses the project's next key and makes no mirror", async () => {
    const h = setup();
    h.driver.script = async function* (req) {
      await req.toolContext.ops.dispatchTicket(req.toolContext, { projectKey: "ACME", title: "Handle the event", spec: "Do it" });
    };
    const s = await h.orch.injectOutput("events", '{"event":"assigned","to":"mark"}');
    await h.orch.idle();
    expect(h.orch.getSession(s!.id).outcome).toBe("Dispatched to ACME-1 in ACME");
    const t = h.orch.ticketDetail("ACME-1").ticket;
    expect(t.title).toBe("Handle the event");
    expect(t.externalRef).toBeNull();
  });

  test("dispatch can put the new ticket on an existing branch, as its base too; a bad branch name is refused", async () => {
    const h = setup();
    Bun.spawnSync(["git", "init", "-q"], { cwd: h.project.path }); // a branch needs a git repo
    const errors: string[] = [];
    h.driver.script = async function* (req) {
      const ops = req.toolContext.ops;
      await ops.dispatchTicket(req.toolContext, { projectKey: "ACME", title: "Bad", spec: "x", branch: "bad..name" }).catch((e: Error) => errors.push(e.message));
      await ops.dispatchTicket(req.toolContext, { projectKey: "ACME", title: "Fix PR 12", spec: "Resolve the conflicts", branch: "feature/pr-12", baseBranch: "feature/pr-12" });
    };
    const s = await h.orch.injectOutput("github", '{"pr":12}');
    await h.orch.idle();
    expect(errors[0]).toContain("..");
    expect(h.orch.getSession(s!.id).outcome).toBe("Dispatched to ACME-1 in ACME");
    expect(h.orch.ticketDetail("ACME-1").ticket).toMatchObject({ title: "Fix PR 12", requestedBranch: "feature/pr-12", baseBranch: "feature/pr-12" });
  });

  test("one output with several items can dispatch each; decline is refused after a dispatch", async () => {
    const h = setup();
    let declineErr: unknown = null;
    h.driver.script = async function* (req) {
      const ops = req.toolContext.ops;
      await ops.dispatchTicket(req.toolContext, { projectKey: "ACME", key: "JIRA-7", title: "First", spec: "one" });
      await ops.dispatchTicket(req.toolContext, { projectKey: "ACME", key: "JIRA-8", title: "Second", spec: "two" });
      try {
        await ops.declineWork(req.toolContext, "changed my mind");
      } catch (e) {
        declineErr = e;
      }
    };
    const s = await h.orch.injectOutput("jira", '{"key":"JIRA-7"}\n{"key":"JIRA-8"}');
    await h.orch.idle();
    const session = h.orch.getSession(s!.id);
    expect(session.triageStatus).toBe("dispatched");
    expect(session.outcome).toBe("Dispatched to ACME-1 (JIRA-7) in ACME; Dispatched to ACME-2 (JIRA-8) in ACME");
    expect(session.title).toBe("First");
    expect(h.orch.listTickets().map((t) => [t.key, t.externalRef?.key]).sort()).toEqual([["ACME-1", "JIRA-7"], ["ACME-2", "JIRA-8"]]);
    expect(String(declineErr)).toContain("already dispatched");
  });

  test("decline_work can retitle the Inbox item", async () => {
    const h = setup();
    h.driver.script = async function* (req) {
      await req.toolContext.ops.declineWork(req.toolContext, "Not assigned to me", "Ticket reassigned to Sam");
    };
    const s = await h.orch.injectOutput("events", '{"event":"assigned","to":"sam"}');
    await h.orch.idle();
    const session = h.orch.getSession(s!.id);
    expect(session.title).toBe("Ticket reassigned to Sam");
    expect(session.outcome).toBe("Declined: Not assigned to me");
  });

  test("[big] output dispatches as conductor tickets; triage run without a decision fails", async () => {
    const h = setup();
    await h.orch.injectOutput("jira", { key: "FOO-50", summary: "[big] migrate everything" }, ROUTE);
    await Bun.sleep(20);
    expect(h.orch.ticketDetail("ACME-1").ticket).toMatchObject({ kind: "conductor", externalRef: { key: "FOO-50" } });
    await h.orch.idle(20_000);

    h.driver.script = async function* () {
      yield { type: "text", text: "hmm" };
    };
    const s = await h.orch.injectOutput("jira", { key: "FOO-51", summary: "?" });
    await h.orch.idle();
    expect(h.orch.getSession(s!.id).triageStatus).toBe("failed");
  });
});

describe("mcp tokens", () => {
  test("a run-scoped token resolves only while its run is active", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x /hold" });
    await Bun.sleep(5);
    const url = h.driver.calls[0]!.mcpUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:9\/mcp\/[0-9a-f]{48}$/);
    const token = url.split("/").pop()!;
    const run = h.orch.mcpRun(token)!;
    expect(run.ctx.ticket!.id).toBe(t.id);
    expect(run.ctx.runKind).toBe("work");
    expect(h.orch.mcpRun("nope")).toBeNull();
    h.driver.release();
    await h.orch.idle();
    expect(h.orch.mcpRun(token)).toBeNull();
    // each run gets its own token
    const tokens = new Set(h.driver.calls.map((c) => c.mcpUrl));
    expect(tokens.size).toBe(h.driver.calls.length);
  });
});

describe("recovery", () => {
  test("runs left queued/running by a previous process are failed on start", async () => {
    const home = tempHome();
    const dbPath = join(home, "h.db");
    const first = makeOrchestrator({ paths: { home } as any, dbPath });
    const dir = join(home, "p");
    mkdirSync(dir);
    const p = first.orch.createProject({ path: dir });
    const t = await first.orch.createTicket({ projectId: p.id, spec: "x /hold" });
    const y = await first.orch.createTicket({ projectId: p.id, spec: "y" });
    // Let the other ticket's work and review finish, so nothing of the first process touches the DB
    // after it closes.
    while (first.orch.ticketDetail(y.key).ticket.agentReview !== "approved" || first.orch.ticketDetail(y.key).ticket.busy) await Bun.sleep(1);
    // simulate a crash: no stop(), just a new process on the same DB
    first.store.db.close();

    const second = makeOrchestrator({ paths: { home } as any, dbPath });
    second.orch.start();
    const runs = second.store.runs.listBySession(t.sessionId);
    expect(runs.map((r) => [r.status, r.error])).toEqual([["failed", "service restarted"]]);
    expect(second.store.runs.listUnfinished()).toEqual([]);
    const cur = second.orch.ticketDetail(t.key).ticket;
    expect(cur.busy).toBe(false);
    expect(cur.status).toBe("in_progress"); // nothing is re-enqueued
    await second.orch.idle();
    expect(second.driver.calls).toEqual([]);
  });
});

describe("worktrees", () => {
  test("git projects get a worktree + branch per ticket; plain dirs use the project path", async () => {
    const h = setup();
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const p = h.orch.createProject({ path: repo, key: "repo" });
    const t = await h.orch.createTicket({ projectId: p.id, spec: "x" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.workdir).toBe(join(h.paths.worktreesDir, "REPO-1"));
    expect(cur.branch).toBe("harness/repo-1");
    expect(existsSync(join(cur.workdir!, ".git"))).toBe(true);
    expect(h.driver.calls[0]!.cwd).toBe(cur.workdir!);
    const branches = new TextDecoder().decode(git("branch", "--list", "harness/*").stdout);
    expect(branches).toContain("harness/repo-1");

    const plain = await h.orch.createTicket({ projectId: h.project.id, spec: "y" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(plain.key).ticket.workdir).toBe(h.project.path);
    expect(h.orch.ticketDetail(plain.key).ticket.branch).toBeNull();
  });

  test("re-opening a done ticket whose worktree and branch were removed recreates them", async () => {
    const h = setup();
    h.driver.commitsWork = true;
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const p = h.orch.createProject({ path: repo, key: "repo" });
    const t = await h.orch.createTicket({ projectId: p.id, spec: "x" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    const done = h.orch.ticketDetail(t.key).ticket;
    expect(done.status).toBe("done");
    // What the complete run does: remove the worktree and delete the merged branch.
    git("worktree", "remove", "--force", done.workdir!);
    git("branch", "-D", done.branch!);
    expect(existsSync(done.workdir!)).toBe(false);

    await h.orch.reopenTicket(t.key, { notes: "one more fix" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("review");
    expect(cur.workdir).toBe(done.workdir);
    expect(cur.branch).toBe("harness/repo-1");
    expect(existsSync(join(cur.workdir!, ".git"))).toBe(true);
    expect(h.driver.calls.filter((c) => c.kind === "work").at(-1)!.cwd).toBe(cur.workdir!);
    expect(new TextDecoder().decode(git("branch", "--list", "harness/*").stdout)).toContain("harness/repo-1");
  });

  test("a chat's resume_work on a done ticket recreates its removed worktree and names it", async () => {
    const h = setup();
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const p = h.orch.createProject({ path: repo, key: "repo" });
    const t = await h.orch.createTicket({ projectId: p.id, spec: "x" });
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    const done = h.orch.ticketDetail(t.key).ticket;
    git("worktree", "remove", "--force", done.workdir!);
    git("branch", "-D", done.branch!);

    const moved: string[] = [];
    h.driver.script = async function* (req) {
      if (req.kind !== "chat") return;
      moved.push(await req.toolContext.ops.resumeWork(req.toolContext, "re-checking"));
      yield { type: "text", text: "Checked." };
    };
    await h.orch.sendMessage(t.key, "check it again");
    await h.orch.idle();
    // The chat ran from the project checkout; the result points it at the recreated worktree.
    expect(h.driver.calls.find((c) => c.kind === "chat")!.cwd).toBe(repo);
    expect(moved).toEqual([done.workdir!]);
    expect(existsSync(join(done.workdir!, ".git"))).toBe(true);
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur).toMatchObject({ status: "review", workdir: done.workdir, branch: "harness/repo-1" });
    expect(h.store.sessions.get(t.sessionId)!.cwd).toBe(done.workdir!);
  });

  /** A git repo with one commit, as a project (worktree setting as given). */
  const gitProject = (h: ReturnType<typeof setup>, useWorktrees: boolean) => {
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (...args: string[]) => new TextDecoder().decode(Bun.spawnSync(["git", ...args], { cwd: repo, env }).stdout);
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    return { repo, git, project: h.orch.createProject({ path: repo, key: "repo", useWorktrees }) };
  };

  test("useWorktree false: a git project with worktrees on runs the ticket in the project checkout", async () => {
    const h = setup();
    const { repo, git, project } = gitProject(h, true);
    const t = await h.orch.createTicket({ projectId: project.id, spec: "x", useWorktree: false });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.workdir, cur.branch, cur.useWorktree]).toEqual([repo, null, false]);
    expect(h.driver.calls[0]!.cwd).toBe(repo);
    expect(existsSync(join(h.paths.worktreesDir, "REPO-1"))).toBe(false);
    expect(git("branch", "--list", "harness/*")).toBe("");
  });

  test("useWorktree true: a project with worktrees off still gets one for that ticket", async () => {
    const h = setup();
    const { project } = gitProject(h, false);
    const off = await h.orch.createTicket({ projectId: project.id, spec: "follows the project" });
    const on = await h.orch.createTicket({ projectId: project.id, spec: "x", useWorktree: true });
    await h.orch.idle();
    expect(h.orch.ticketDetail(off.key).ticket.branch).toBeNull();
    const cur = h.orch.ticketDetail(on.key).ticket;
    expect([cur.workdir, cur.branch]).toEqual([join(h.paths.worktreesDir, on.key), `harness/${on.key.toLowerCase()}`]);
    expect(existsSync(join(cur.workdir!, ".git"))).toBe(true);
  });

  test("the choice is kept through planning: started later, it still runs in the project checkout", async () => {
    const h = setup();
    const { repo, project } = gitProject(h, true);
    const t = await h.orch.createTicket({ projectId: project.id, spec: "x", start: false, useWorktree: false });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.workdir).toBeNull();
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.workdir, cur.branch]).toEqual([repo, null]);
    expect(existsSync(join(h.paths.worktreesDir, t.key))).toBe(false);
  });

  test("re-opening a done project-checkout ticket keeps it in the project checkout", async () => {
    const h = setup();
    const { repo, project } = gitProject(h, true);
    const t = await h.orch.createTicket({ projectId: project.id, spec: "x", useWorktree: false });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    await h.orch.reopenTicket(t.key, { notes: "one more fix" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.workdir, cur.branch]).toEqual([repo, null]);
    expect(h.driver.calls.filter((c) => c.kind === "work").at(-1)!.cwd).toBe(repo);
    expect(existsSync(join(h.paths.worktreesDir, t.key))).toBe(false);
  });

  test("re-opening a done ticket with a removed worktree recreates it too", async () => {
    const h = setup();
    h.driver.commitsWork = true;
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const p = h.orch.createProject({ path: repo, key: "repo" });
    const t = await h.orch.createTicket({ projectId: p.id, spec: "x" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    const done = h.orch.ticketDetail(t.key).ticket;
    git("worktree", "remove", "--force", done.workdir!);

    const cur = await h.orch.reopenTicket(t.key, { notes: "tweak it" });
    expect(cur.status).toBe("in_progress");
    expect(existsSync(join(done.workdir!, ".git"))).toBe(true);
    await h.orch.idle();
    const last = h.driver.calls.filter((c) => c.kind === "work").at(-1)!;
    expect(last.prompt).toContain("tweak it");
    expect(last.cwd).toBe(done.workdir!);
  });
});

describe("@-mentioned files", () => {
  test("the brief's and a message's mentioned files go to the agent; the transcript keeps what was typed", async () => {
    const h = setup();
    writeFileSync(join(h.project.path, "notes.md"), "remember the milk\n");
    mkdirSync(join(h.project.path, "src"));
    writeFileSync(join(h.project.path, "src", "app.ts"), "export {}\n");
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Read @notes.md first", start: false });
    await h.orch.idle();
    const plan = h.driver.calls[0]!;
    expect(plan.prompt).toStartWith("Read @notes.md first\n\n<mentioned-files>");
    expect(plan.prompt).toContain('<file path="notes.md">\nremember the milk\n</file>');
    const entries = h.store.transcript.list(t.sessionId);
    expect(entries.find((e) => e.role === "user")!.content).toEqual({ type: "text", text: "Read @notes.md first" });
    expect(statuses(h, t.sessionId)).toContain("Attached @notes.md");

    await h.orch.sendMessage(t.key, "and @src/app.ts, not @../escape");
    await h.orch.idle();
    expect(h.driver.calls[1]!.prompt).toContain('<file path="src/app.ts">\nexport {}\n</file>');
    expect(h.driver.calls[1]!.prompt).not.toContain("notes.md");
  });

  test("a chat question gets its files; review and complete runs don't re-attach the brief's", async () => {
    const h = setup();
    writeFileSync(join(h.project.path, "notes.md"), "remember the milk\n");
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Read @notes.md" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "what does @notes.md say?");
    await h.orch.idle();
    const chat = h.driver.calls.find((c) => c.kind === "chat")!;
    expect(chat.prompt).toContain('<file path="notes.md">');
    await h.orch.completeTicket(t.key, {});
    await h.orch.idle();
    for (const kind of ["review", "complete"]) {
      const call = h.driver.calls.find((c) => c.kind === kind)!;
      expect(call.prompt).toContain("@notes.md");
      expect(call.prompt).not.toContain("<mentioned-files>");
    }
  });

  test("a prompt without mentions reaches the agent as typed, with no status line", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "email a@b.com", start: false });
    await h.orch.idle();
    expect(h.driver.calls[0]!.prompt).toBe("email a@b.com");
    expect(statuses(h, t.sessionId).some((s) => s.startsWith("Attached"))).toBe(false);
  });

  test("projectFiles and ticketFiles search the project folder, and the ticket's worktree once it has one", async () => {
    const h = setup();
    writeFileSync(join(h.project.path, "readme.md"), "x");
    expect(await h.orch.projectFiles(h.project.id, "read")).toEqual([{ path: "readme.md", kind: "file" }]);
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
    expect(await h.orch.ticketFiles(t.key, "read")).toEqual([{ path: "readme.md", kind: "file" }]);
    const wt = join(h.home, "elsewhere");
    mkdirSync(wt);
    writeFileSync(join(wt, "readme-wt.md"), "x");
    h.store.tickets.update(t.id, { workdir: wt });
    expect(await h.orch.ticketFiles(t.key, "readme")).toEqual([{ path: "readme-wt.md", kind: "file" }]);
    expect(() => h.orch.projectFiles("nope", "")).toThrow(HarnessError);
    expect(() => h.orch.ticketFiles("NOPE-1", "")).toThrow(HarnessError);
  });
});

describe("agent notes", () => {
  test("update_notes replaces the ticket's notes without an Activity entry; the next run's prompt and get_ticket carry them, list_tickets leaves them out", async () => {
    const h = setup();
    const wrote: boolean[] = [];
    const seen: { get?: unknown; list?: unknown } = {};
    h.driver.script = async function* (req) {
      const ctx = req.toolContext;
      if (req.kind === "work") {
        wrote.push(ctx.ops.wroteNotes(ctx));
        await ctx.ops.updateNotes(ctx, "first draft");
        await ctx.ops.updateNotes(ctx, "  ## Where\n- src/x.ts {{baseBranch}}  ");
        wrote.push(ctx.ops.wroteNotes(ctx));
        await ctx.ops.submitForReview(ctx, "done", true, { skipAgentReview: true });
      } else if (req.kind === "chat") {
        wrote.push(ctx.ops.wroteNotes(ctx));
        seen.get = (await ctx.ops.getTicket(ctx, ctx.ticket!.key)).ticket;
        seen.list = (await ctx.ops.listTickets(ctx, {})).tickets[0];
        yield { type: "text", text: "ok" };
      }
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.agentNotes).toBe("## Where\n- src/x.ts {{baseBranch}}");
    expect(h.driver.calls[0]!.systemPrompt).toContain("This ticket has no agent notes yet.");

    await h.orch.sendMessage(t.key, "what did you find?");
    await h.orch.idle();
    const chat = h.driver.calls.find((c) => c.kind === "chat")!;
    expect(chat.systemPrompt).toContain("<agent-notes>\n## Where\n- src/x.ts {{baseBranch}}\n</agent-notes>");
    expect(seen.get).toMatchObject({ key: t.key, agentNotes: "## Where\n- src/x.ts {{baseBranch}}" });
    expect(seen.list).not.toHaveProperty("agentNotes");
    // wroteNotes is per run: false before the work run wrote, true after, false again in the chat.
    expect(wrote).toEqual([false, true, false]);
    expect(h.orch.activity(t.key).filter((a) => a.body.includes("src/x.ts"))).toEqual([]);
  });

  test("empty notes clear them", async () => {
    const h = setup();
    h.driver.script = async function* (req) {
      const ctx = req.toolContext;
      if (req.kind !== "work") return;
      await ctx.ops.updateNotes(ctx, "something");
      expect(await ctx.ops.updateNotes(ctx, "   ")).toBe("");
      await ctx.ops.submitForReview(ctx, "done", true, { skipAgentReview: true });
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.agentNotes).toBeNull();
  });
});
