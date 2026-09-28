import { describe, expect, test } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, Ticket } from "@harness/shared";
import { FakeDriver, makeOrchestrator, tempHome } from "../testing/fakes";
import { HarnessError } from "./errors";

function setup(opts: { requireHumanReview?: boolean; autoComplete?: boolean; driver?: FakeDriver } = {}) {
  const h = makeOrchestrator({ driver: opts.driver });
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, requireHumanReview: opts.requireHumanReview ?? true, autoComplete: opts.autoComplete });
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, project, events };
}

const statuses = (h: ReturnType<typeof setup>, sessionId: string) =>
  h.store.transcript
    .list(sessionId)
    .filter((e) => e.content.type === "status")
    .map((e) => (e.content as { text: string }).text);

const runKinds = (h: ReturnType<typeof setup>, t: Ticket) => h.store.runs.listBySession(t.sessionId).map((r) => `${r.kind}:${r.status}`);

describe("ticket lifecycle", () => {
  test("start:true runs work with the brief, auto-reviews, then human approve + complete → done", async () => {
    const h = setup({ autoComplete: false });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "Add a button" });
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

    cur = h.orch.humanReview(t.key, { decision: "approve" });
    expect(cur.humanReview).toBe("approved");
    expect(statuses(h, t.sessionId)).toContain("Ready to complete");

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
    const summaries = h.orch.summaries(t.key).map((s) => `${s.author}:${s.body}`);
    expect(summaries).toContain("agent:All done.");
  });

  test("start:false plans (update_plan), then /start runs the approved plan", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "Refactor auth", start: false });
    expect(t.status).toBe("planning");
    await h.orch.idle();
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("planning");
    expect(cur.description).toBe("1. Do Refactor auth");
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
    expect(work.prompt).toContain("The plan is approved");
    expect(work.prompt).toContain("1. Do also do tests");
    await expect(h.orch.startTicket(t.key)).rejects.toBeInstanceOf(HarnessError);
  });

  test("work runs resume driver state; review runs start fresh and never write state", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    await h.orch.idle();
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    const [plan, work, review] = h.driver.calls;
    expect(plan!.state).toBeNull();
    expect(work!.state).toEqual({ turns: 1 });
    expect(review!.kind).toBe("review");
    expect(review!.state).toBeNull();
    // The reviewer's { reviewer: true } state must not leak into the session
    expect(h.store.sessions.getDriverState(t.sessionId)).toEqual({ turns: 2 });
  });

  test("block → blocked with reason; human reply → in_progress + work run with the message", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "do it /block Which database?" });
    await h.orch.idle();
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toBe("Which database?");
    expect(h.orch.summaries(t.key).map((s) => s.body)).toContain("Blocked: Which database?");
    // blocked runs do not auto-submit and do not get a review
    expect(runKinds(h, t)).toEqual(["work:succeeded"]);

    cur = await h.orch.sendMessage(t.key, "Postgres");
    expect(cur.status).toBe("in_progress");
    expect(cur.blockedReason).toBeNull();
    await h.orch.idle();
    expect(h.driver.calls[1]!.prompt).toBe("Postgres");
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
  });

  test("work run that ends without submitting is auto-submitted with the last assistant text", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "quiet /nosubmit" });
    await h.orch.idle();
    const d = h.orch.ticketDetail(t.key);
    expect(d.ticket.status).toBe("review");
    const sys = d.summaries.find((s) => s.author === "system")!;
    expect(sys.body).toBe('Hello from fake! You said: "quiet /nosubmit"');
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded"]);
  });

  test("auto-submit is skipped while another human message is queued", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "first /hold /nosubmit" });
    await Bun.sleep(5);
    await h.orch.sendMessage(t.key, "second /nosubmit");
    h.driver.release();
    await h.orch.idle();
    // Only the second run's end triggers the submit
    const sys = h.orch.summaries(t.key).filter((s) => s.author === "system");
    expect(sys.map((s) => s.body)).toEqual(['Hello from fake! You said: "second /nosubmit"']);
    expect(runKinds(h, t)).toEqual(["work:succeeded", "work:succeeded", "review:succeeded"]);
  });

  test("work run failure (error event or thrown) → blocked with the error", async () => {
    const h = setup();
    const a = await h.orch.createTicket({ projectId: h.project.id, prompt: "/fail disk full" });
    const b = await h.orch.createTicket({ projectId: h.project.id, prompt: "/throw kaboom" });
    await h.orch.idle();
    const ta = h.orch.ticketDetail(a.key).ticket;
    expect(ta.status).toBe("blocked");
    expect(ta.blockedReason).toBe("disk full");
    expect(h.orch.ticketDetail(a.key).runs[0]!.status).toBe("failed");
    const tb = h.orch.ticketDetail(b.key).ticket;
    expect(tb.blockedReason).toBe("kaboom");
    // The detail view has no blocked callout; the Summary tab is where the reason shows.
    expect(h.orch.summaries(a.key).map((s) => [s.author, s.body])).toEqual([["system", "Run failed: disk full"]]);
    expect(h.orch.summaries(b.key).map((s) => s.body)).toEqual(["Run failed: kaboom"]);
    expect(h.store.transcript.list(a.sessionId).some((e) => e.content.type === "error" && e.content.text === "disk full")).toBe(true);
  });

  test("agent request_changes loops back to work until the reviewer approves", async () => {
    const driver = new FakeDriver();
    driver.rejectsLeft = 2;
    const h = setup({ driver });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "loop" });
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
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
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

  test("projects without human review are ready right after the agent approves", async () => {
    const h = setup({ requireHumanReview: false, autoComplete: false });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.agentReview, cur.humanReview]).toEqual(["approved", "approved"]);
    expect(statuses(h, t.sessionId)).toContain("Ready to complete");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded"]);
  });

  test("auto-complete is on by default: the human approval completes the ticket without pressing Complete", async () => {
    const h = setup();
    expect(h.project.autoComplete).toBe(true);
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
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

  test("auto-complete: the agent approval completes the ticket when the human approved first", async () => {
    const driver = new FakeDriver();
    driver.rejectsLeft = 1;
    const h = setup({ driver, requireHumanReview: false });
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    // Human review is pre-approved; the first agent review rejects, the second approves and completes.
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "work:succeeded", "review:succeeded", "complete:succeeded"]);
  });

  test("auto-complete: a second Complete while the auto-complete run is queued is refused", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await expect(h.orch.completeTicket(t.key)).rejects.toThrow(/already completing/);
    await h.orch.idle();
    expect(runKinds(h, t).filter((k) => k.startsWith("complete"))).toEqual(["complete:succeeded"]);
  });

  test("auto-complete: turning it off per project brings back the manual Complete step", async () => {
    const h = setup();
    const p = h.orch.updateProject(h.project.id, { autoComplete: false });
    expect(p.autoComplete).toBe(false);
    expect(h.store.projects.get(h.project.id)!.autoComplete).toBe(false);
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    expect(statuses(h, t.sessionId)).toContain("Ready to complete");
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded"]);
  });

  test("complete requires review; skipAgent marks done without a run; drag to done runs nothing", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    await h.orch.idle();
    await expect(h.orch.completeTicket(t.key)).rejects.toThrow(/must be in review/);
    const done = await h.orch.completeTicket(t.key, { skipAgent: true });
    expect(done.status).toBe("done");
    expect(runKinds(h, t)).toEqual(["plan:succeeded"]);

    const u = await h.orch.createTicket({ projectId: h.project.id, prompt: "y", start: false });
    await h.orch.idle();
    const dragged = await h.orch.updateTicket(u.key, { status: "done" });
    expect(dragged.status).toBe("done");
    expect(runKinds(h, u)).toEqual(["plan:succeeded"]);
  });

  test("complete run failure → blocked", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    h.driver.script = async function* () {
      yield { type: "error", message: "merge conflict" };
    };
    await h.orch.completeTicket(t.key);
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toBe("merge conflict");
  });

  test("cancel aborts the active run and drops queued runs; status unchanged", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "long /hold" });
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

  test("rerun agent review; message in review reopens work", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    h.orch.rerunAgentReview(t.key);
    await h.orch.idle();
    expect(runKinds(h, t)).toEqual(["work:succeeded", "review:succeeded", "review:succeeded"]);
    const cur = await h.orch.sendMessage(t.key, "one more thing");
    expect(cur.status).toBe("in_progress");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
  });

  test("re-open sends a done ticket back to work with the notes; only done tickets, notes required", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
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
    expect(h.orch.summaries(t.key).map((s) => `${s.author}:${s.body}`)).toContain("human:Re-opened: the button is the wrong color");
  });

  test("dragging a done ticket to in progress re-opens it with the plan", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "the plan" });
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

  test("external keys, duplicates and validation", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "mirror", key: "foo-123", start: false });
    expect(t.key).toBe("FOO-123");
    await expect(h.orch.createTicket({ projectId: h.project.id, prompt: "again", key: "FOO-123" })).rejects.toMatchObject({ status: 409 });
    await expect(h.orch.createTicket({ projectId: h.project.id, prompt: "bad", key: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.project.id, prompt: "x", driver: "missing" })).rejects.toMatchObject({ status: 400 });
    await expect(h.orch.createTicket({ projectId: h.project.id, prompt: "x", dependsOn: ["ACME-77"] })).rejects.toMatchObject({ status: 400 });
    const n = await h.orch.createTicket({ projectId: h.project.id, prompt: "native", start: false });
    expect(n.key).toBe("ACME-1");
    expect(n.title).toBe("native");
    await h.orch.idle();
  });

  test("delete removes ticket + session and closes the browser tab", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x /hold" });
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
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
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

describe("scheduling", () => {
  test("dependsOn + autoStart: dependent starts when its dependency is done", async () => {
    const h = setup();
    const a = await h.orch.createTicket({ projectId: h.project.id, prompt: "A" });
    const b = await h.orch.createTicket({ projectId: h.project.id, prompt: "B", start: false, autoStart: true, dependsOn: [a.key] });
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
    const a = await h.orch.createTicket({ projectId: h.project.id, prompt: "A", start: false });
    const manual = await h.orch.createTicket({ projectId: h.project.id, prompt: "B", start: false, dependsOn: [a.key] });
    const eager = await h.orch.createTicket({ projectId: h.project.id, prompt: "C", start: true, dependsOn: [a.key] });
    expect(eager.status).toBe("planning");
    expect(eager.autoStart).toBe(true);
    await h.orch.idle();
    await h.orch.updateTicket(a.key, { status: "done" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(manual.key).ticket.status).toBe("planning");
    expect(h.orch.ticketDetail(eager.key).ticket.status).toBe("review");
  });
});

describe("concurrency", () => {
  test("runs are serialized per session", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "a /hold /nosubmit" });
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
    for (let i = 0; i < 5; i++) await h.orch.createTicket({ projectId: h.project.id, prompt: `t${i} /hold` });
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
    const c = await h.orch.createTicket({ projectId: h.project.id, prompt: "Big job\n- Build API\n- Build UI", kind: "conductor" });
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
          keys.push((await req.toolContext.ops.createTicket(req.toolContext, { title, description: title, autoStart: false })).key);
        }
        await gate;
      }
    };
    const c = await h.orch.createTicket({ projectId: h.project.id, prompt: "go", kind: "conductor" });
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
      if (req.kind === "work") return void (await ops.submitForReview(req.toolContext, "done"));
      if (req.kind === "review") return void (await ops.reviewDecision(req.toolContext, "approve", ""));
      if (req.kind !== "conductor") return;
      if (!keys.length) {
        keys.push((await ops.createTicket(req.toolContext, { title: "only", description: "only", autoStart: true })).key);
        return;
      }
      const child = (await ops.getTicket(req.toolContext, keys[0]!)).ticket;
      if (child.status === "review" && child.agentReview === "approved" && child.humanReview === "pending") {
        await ops.reviewTicket(req.toolContext, child.key, "approve", "");
      }
    };
    await h.orch.createTicket({ projectId: h.project.id, prompt: "go", kind: "conductor" });
    await h.orch.idle();
    const child = h.orch.ticketDetail(keys[0]!).ticket;
    expect([child.status, child.agentReview, child.humanReview]).toEqual(["review", "approved", "approved"]);
    expect(runKinds(h, child)).toEqual(["work:succeeded", "review:succeeded"]);
    expect(statuses(h, child.sessionId)).toContain("Ready to complete");
  });

  test("conductor auto-submits when its run ends with every child done", async () => {
    const h = setup();
    const keys: string[] = [];
    h.driver.script = async function* (req) {
      if (req.kind === "conductor" && !keys.length) {
        keys.push((await req.toolContext.ops.createTicket(req.toolContext, { title: "only", description: "only", autoStart: false })).key);
      }
    };
    const c = await h.orch.createTicket({ projectId: h.project.id, prompt: "go", kind: "conductor" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(c.key).ticket.status).toBe("in_progress");
    await h.orch.updateTicket(keys[0]!, { status: "done" });
    await h.orch.idle();
    const d = h.orch.ticketDetail(c.key);
    expect(d.ticket.status).toBe("review");
    expect(d.summaries.some((s) => s.author === "system")).toBe(true);
  });

  test("default conductor children chain via dependsOn", async () => {
    const h = setup();
    const c = await h.orch.createTicket({ projectId: h.project.id, prompt: "Do it all", kind: "conductor" });
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

  test("review_ticket and complete_ticket reject non-conductor callers and non-children", async () => {
    const h = setup();
    const other = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    const errs: string[] = [];
    h.driver.script = async function* (req) {
      const ctx = req.toolContext;
      if (ctx.ticket?.key === other.key) return;
      for (const call of [() => ctx.ops.reviewTicket(ctx, other.key, "approve", ""), () => ctx.ops.completeTicket(ctx, other.key)]) {
        await call().catch((e) => errs.push(String(e)));
      }
    };
    await h.orch.idle();
    await h.orch.createTicket({ projectId: h.project.id, prompt: "work" });
    await h.orch.createTicket({ projectId: h.project.id, prompt: "conduct", kind: "conductor" });
    await h.orch.idle();
    expect(errs.slice(0, 2).every((e) => /Only conductor tickets/.test(e))).toBe(true);
    expect(errs.slice(-2).every((e) => e.includes(`${other.key} is not a child of`))).toBe(true);
  });
});

describe("triage", () => {
  test("dispatches to the mapped project with the external key", async () => {
    const h = setup();
    h.orch.createMapping({ pattern: "FOO", projectId: h.project.id });
    const s = await h.orch.injectWorkItem("jira", { key: "FOO-123", summary: "Fix login", url: "https://x/FOO-123", updated: "1" });
    expect(s!.key).toBe("TRIAGE-1");
    expect(s!.kind).toBe("triage");
    expect(s!.triageStatus).toBe("triaging");
    await h.orch.idle();
    const session = h.orch.getSession(s!.id);
    expect(session.triageStatus).toBe("dispatched");
    expect(session.outcome).toBe("Dispatched to FOO-123 in ACME");
    const t = h.orch.ticketDetail("FOO-123").ticket;
    expect(t.projectId).toBe(h.project.id);
    expect(t.externalRef).toMatchObject({ source: "jira", key: "FOO-123", url: "https://x/FOO-123" });
    expect(t.status).toBe("review"); // start: true → worked → reviewed
    expect(h.orch.listSessions("triage").map((x) => x.key)).toEqual(["TRIAGE-1"]);
  });

  test("declines unmapped work and dedupes by (source, key, version)", async () => {
    const h = setup();
    const s = await h.orch.injectWorkItem("jira", { key: "BAR-1", summary: "?", updated: "a" });
    await h.orch.idle();
    expect(h.orch.getSession(s!.id).triageStatus).toBe("declined");
    expect(h.orch.getSession(s!.id).outcome).toMatch(/^Declined: /);
    expect(await h.orch.injectWorkItem("jira", { key: "BAR-1", summary: "?", updated: "a" })).toBeNull();
    const again = await h.orch.injectWorkItem("jira", { key: "BAR-1", summary: "?", updated: "b" });
    expect(again!.key).toBe("TRIAGE-2");
    await h.orch.idle();
    await expect(h.orch.injectWorkItem("jira", { nope: true })).rejects.toMatchObject({ status: 400 });
  });

  test("an existing ticket with the key gets a message instead of a duplicate", async () => {
    const h = setup();
    h.orch.createMapping({ pattern: "/^FOO-\\d+$/", projectId: h.project.id });
    await h.orch.injectWorkItem("jira", { key: "FOO-9", summary: "v1", updated: "1" });
    await h.orch.idle();
    const before = h.orch.ticketDetail("FOO-9");
    expect(before.ticket.status).toBe("review");
    const s2 = await h.orch.injectWorkItem("jira", { key: "FOO-9", summary: "v2", updated: "2" });
    await h.orch.idle();
    expect(h.orch.getSession(s2!.id).outcome).toBe("Sent update to existing FOO-9");
    expect(h.orch.listTickets().filter((t) => t.key === "FOO-9").length).toBe(1);
    const lastWork = h.driver.calls.filter((c) => c.kind === "work").at(-1)!;
    expect(lastWork.prompt).toBe("Handle FOO-9");
    expect(h.orch.ticketDetail("FOO-9").runs.length).toBeGreaterThan(before.runs.length);
  });

  test("[big] items dispatch as conductor tickets; triage run without a decision fails", async () => {
    const h = setup();
    h.orch.createMapping({ pattern: "FOO", projectId: h.project.id });
    await h.orch.injectWorkItem("jira", { key: "FOO-50", summary: "[big] migrate everything" });
    await Bun.sleep(20);
    expect(h.orch.ticketDetail("FOO-50").ticket.kind).toBe("conductor");
    await h.orch.idle(20_000);

    h.driver.script = async function* () {
      yield { type: "text", text: "hmm" };
    };
    const s = await h.orch.injectWorkItem("jira", { key: "FOO-51", summary: "?" });
    await h.orch.idle();
    expect(h.orch.getSession(s!.id).triageStatus).toBe("failed");
  });
});

describe("mcp tokens", () => {
  test("a run-scoped token resolves only while its run is active", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x /hold" });
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
    const t = await first.orch.createTicket({ projectId: p.id, prompt: "x /hold" });
    await first.orch.createTicket({ projectId: p.id, prompt: "y" });
    await Bun.sleep(5);
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
    const t = await h.orch.createTicket({ projectId: p.id, prompt: "x" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.workdir).toBe(join(h.paths.worktreesDir, "REPO-1"));
    expect(cur.branch).toBe("harness/repo-1");
    expect(existsSync(join(cur.workdir!, ".git"))).toBe(true);
    expect(h.driver.calls[0]!.cwd).toBe(cur.workdir!);
    const branches = new TextDecoder().decode(git("branch", "--list", "harness/*").stdout);
    expect(branches).toContain("harness/repo-1");

    const plain = await h.orch.createTicket({ projectId: h.project.id, prompt: "y" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(plain.key).ticket.workdir).toBe(h.project.path);
    expect(h.orch.ticketDetail(plain.key).ticket.branch).toBeNull();
  });

  test("re-opening a done ticket whose worktree and branch were removed recreates them", async () => {
    const h = setup();
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const p = h.orch.createProject({ path: repo, key: "repo" });
    const t = await h.orch.createTicket({ projectId: p.id, prompt: "x" });
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

  test("a message to a done ticket with a removed worktree recreates it too", async () => {
    const h = setup();
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const p = h.orch.createProject({ path: repo, key: "repo" });
    const t = await h.orch.createTicket({ projectId: p.id, prompt: "x" });
    await h.orch.idle();
    h.orch.humanReview(t.key, { decision: "approve" });
    await h.orch.idle();
    const done = h.orch.ticketDetail(t.key).ticket;
    git("worktree", "remove", "--force", done.workdir!);

    const cur = await h.orch.sendMessage(t.key, "tweak it");
    expect(cur.status).toBe("in_progress");
    expect(existsSync(join(done.workdir!, ".git"))).toBe(true);
    await h.orch.idle();
    const last = h.driver.calls.filter((c) => c.kind === "work").at(-1)!;
    expect([last.prompt, last.cwd]).toEqual(["tweak it", done.workdir!]);
  });
});
