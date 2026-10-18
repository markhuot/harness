import { afterEach, expect, test } from "bun:test";
import { FakeDriver, failScript, gate, replyScript } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const ONE_RUN = { skipAgentReview: true } as const;

test("a ticket created with start runs Work on the brief in the project folder and ends in review", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", ...ONE_RUN });
  await h.settle();
  expect(h.driver.requests).toHaveLength(1);
  expect(h.driver.requests[0]).toMatchObject({ kind: "work", prompt: "Add a button", cwd: h.project.path, state: null });
  expect(h.driver.requests[0]!.systemPrompt.length).toBeGreaterThan(0);
  expect(h.ticket(t.key)).toMatchObject({ status: "review", busy: false });
});

test("the run is recorded with its usage and times from the clock, and its events reach the transcript in order", async () => {
  const h = makeOrchestrator();
  h.driver.script(({ runId }) => [...replyScript(`done ${runId.length > 0}`), { type: "usage", inputTokens: 5, outputTokens: 2, costUsd: 0.02 }]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  const [run] = h.store.runs.listBySession(t.sessionId);
  expect(run).toMatchObject({ kind: "work", status: "succeeded", error: null, inputTokens: 15, outputTokens: 7, costUsd: 0.03, model: null });
  expect(run!.startedAt).toBe(h.clock());
  const entries = h.store.transcript.list(t.sessionId).map((e) => (e.content.type === "text" ? `${e.role}: ${e.content.text}` : e.content.type === "status" ? `status: ${e.content.text}` : e.content.type));
  expect(entries.slice(entries.indexOf("user: Do it"))).toEqual(["user: Do it", "status: Run started (work)", "assistant: done true", "status: Run finished (work)", "status: Moved to review", "status: Agent review: skipped"]);
  expect(h.store.activity.listBySession(t.sessionId).map((a) => a.kind)).toEqual(["moved", "submitted"]);
});

test("every run, transcript entry and ticket change is announced on the bus", async () => {
  const h = makeOrchestrator();
  await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  const kinds = new Set(h.events.map((e) => e.kind));
  for (const k of ["project.upserted", "session.upserted", "ticket.upserted", "run.upserted", "transcript.appended", "activity.added"] as const) expect(kinds.has(k)).toBe(true);
  const runEvents = h.events.filter((e) => e.kind === "run.upserted").map((e) => (e as { run: { status: string } }).run.status);
  expect(runEvents[0]).toBe("queued");
  expect(runEvents.at(-1)).toBe("succeeded");
  expect(runEvents).toContain("running");
});

test("moving a ticket to another column starts the next run on a fresh driver conversation", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  // The run saved its conversation, then the move to review dropped it.
  expect(h.store.sessions.getDriverState(t.sessionId)).toBeNull();
  await h.orch.sendMessage(t.key, "one more thing", { move: true });
  await h.settle();
  expect(h.driver.requests[1]).toMatchObject({ kind: "work", prompt: "one more thing", state: null });
});

test("a message on a ticket in review moves it back to in progress for the run, then to review again", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  const release = gate();
  h.driver.script([...replyScript("working").slice(0, 2), { wait: release }, ...replyScript("finished")]);
  await h.orch.sendMessage(t.key, "change it", { move: true });
  await h.driver.runStarted(2);
  expect(h.ticket(t.key)).toMatchObject({ status: "in_progress", busy: true });
  release.open();
  await h.settle();
  expect(h.ticket(t.key).status).toBe("review");
});

test("a driver that fails blocks the ticket with the reason, records the failed run and the error entry", async () => {
  const h = makeOrchestrator();
  h.driver.script(failScript("the CLI exited with code 2"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", blockedReason: expect.stringContaining("the CLI exited with code 2"), resumeAt: null });
  const [run] = h.store.runs.listBySession(t.sessionId);
  expect(run).toMatchObject({ status: "failed", error: "the CLI exited with code 2" });
  expect(h.store.transcript.list(t.sessionId).some((e) => e.content.type === "error" || (e.content.type === "status" && /failed/.test(e.content.text)))).toBe(true);
});

test("cancelling a ticket aborts the driver's run and marks it cancelled", async () => {
  const h = makeOrchestrator();
  const hold = gate();
  h.driver.script([{ type: "text", text: "starting" }, { wait: hold }]);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  const req = await h.driver.runStarted();
  expect(req.signal.aborted).toBe(false);
  await h.orch.cancelTicket(t.key);
  await h.settle();
  expect(h.driver.aborted).toEqual([req.runId]);
  expect(h.store.runs.get(req.runId)).toMatchObject({ status: "cancelled" });
  expect(h.ticket(t.key).busy).toBe(false);
});

test("stopping the orchestrator aborts runs still going", async () => {
  const h = makeOrchestrator();
  const hold = gate();
  h.driver.script([{ wait: hold }]);
  await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  const req = await h.driver.runStarted();
  await h.orch.stop();
  expect(req.signal.aborted).toBe(true);
});

test("no more runs go at once than maxConcurrentRuns; the next starts when one finishes", async () => {
  const h = makeOrchestrator();
  h.store.settings.set({ maxConcurrentRuns: 1 });
  const first = gate();
  h.driver.script([{ wait: first }, ...replyScript("one")], replyScript("two"));
  const a = await h.orch.createTicket({ projectId: h.project.id, spec: "A", ...ONE_RUN });
  const b = await h.orch.createTicket({ projectId: h.project.id, spec: "B", ...ONE_RUN });
  await h.driver.runStarted(1);
  expect(h.driver.requests).toHaveLength(1);
  expect(h.store.runs.listBySession(b.sessionId)[0]!.status).toBe("queued");
  first.open();
  await h.settle();
  expect(h.driver.requests.map((r) => r.prompt)).toEqual(["A", "B"]);
  expect([h.ticket(a.key).status, h.ticket(b.key).status]).toEqual(["review", "review"]);
});

test("a run left running by a previous process is failed at start, and nothing is re-enqueued", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  const stale = h.store.runs.create({ sessionId: t.sessionId, kind: "work", driver: "fake", prompt: "p" });
  h.store.runs.markRunning(stale.id);
  h.orch.start();
  expect(h.store.runs.get(stale.id)).toMatchObject({ status: "failed" });
  expect(h.store.runs.get(stale.id)!.error).toBeTruthy();
  expect(h.driver.requests).toHaveLength(1);
});

test("a steered message reaches the live run; one the agent never saw becomes the next run", async () => {
  const steering = new FakeDriver({ supportsSteering: true });
  const h2 = makeOrchestrator({ driver: steering });
  const seen: string[] = [];
  const take = gate();
  steering.script([
    { type: "text", text: "working" },
    {
      run: async (req) => {
        if (!req.input!.pending) await new Promise<void>((resolve) => req.input!.onPush(resolve));
        for (const m of req.input!.take()) {
          seen.push(m.text);
          req.input!.delivered(m.id);
        }
        take.open();
      },
    },
    { wait: take },
    ...replyScript("done"),
  ]);
  const t = await h2.orch.createTicket({ projectId: h2.project.id, spec: "Do it", ...ONE_RUN });
  await steering.runStarted();
  await h2.orch.sendMessage(t.key, "also this");
  await h2.settle();
  expect(seen.some((s) => s.includes("also this"))).toBe(true);
  expect(steering.requests).toHaveLength(1);
});

test("a steered message the driver never takes is queued as its own run when the run ends", async () => {
  const steering = new FakeDriver({ supportsSteering: true });
  const h = makeOrchestrator({ driver: steering });
  const hold = gate();
  steering.script([{ wait: hold }, ...replyScript("one")], replyScript("two"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await steering.runStarted();
  await h.orch.sendMessage(t.key, "late word");
  hold.open();
  await h.settle();
  expect(steering.requests).toHaveLength(2);
  expect(steering.requests[1]!.prompt).toContain("late word");
  // Same column, same conversation: the queued run resumes what the first one saved.
  expect(steering.requests[1]!.state).toEqual({ sessionId: "fake-session", costUsd: 0.01 });
});

test("the human unblocks a blocked ticket: back to in progress with the notes in the prompt, both reviews reset", async () => {
  const h = makeOrchestrator();
  h.driver.script(failScript("the CLI exited with code 2"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  h.store.tickets.update(t.id, { humanReview: "approved", agentReview: "approved" });
  h.driver.script(replyScript("carrying on"));
  const out = await h.orch.unblockTicket(t.key, { notes: "  Use blue  " });
  expect(out).toMatchObject({ status: "in_progress", blockedReason: null });
  await h.settle();
  const prompt = h.driver.requests.at(-1)!.prompt;
  expect(prompt).toContain("Use blue");
  expect(prompt).toContain("the CLI exited with code 2");
  expect(h.ticket(t.key)).toMatchObject({ humanReview: "pending" });
});

test("unblocking without notes falls back to the block reason", async () => {
  const h = makeOrchestrator();
  h.driver.script(failScript("worktree trouble"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  h.driver.script(replyScript("ok"));
  await h.orch.unblockTicket(t.key, {});
  await h.settle();
  expect(h.driver.requests.at(-1)!.prompt).toContain("no notes");
  expect(h.ticket(t.key).status).toBe("review");
});

test("unblock is refused (409) for a ticket that isn't blocked, is busy, or waits on a tool approval", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Do it", ...ONE_RUN });
  await h.settle();
  await expect(h.orch.unblockTicket(t.key, {})).rejects.toMatchObject({ status: 409 });
  h.store.tickets.update(t.id, { status: "blocked", blockedReason: "q", pendingApproval: { id: "a1", toolName: "Bash" } as never });
  await expect(h.orch.unblockTicket(t.key, {})).rejects.toMatchObject({ status: 409 });
  h.store.tickets.update(t.id, { pendingApproval: null });
  const hold = gate();
  h.driver.script([{ wait: hold }]);
  await h.orch.sendMessage(t.key, "a question while blocked");
  await h.driver.runStarted(2);
  expect(h.ticket(t.key)).toMatchObject({ status: "blocked", busy: true });
  await expect(h.orch.unblockTicket(t.key, {})).rejects.toMatchObject({ status: 409 });
  hold.open();
  await h.settle();
});
