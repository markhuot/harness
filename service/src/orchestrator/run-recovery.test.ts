import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, RunStatus } from "@harness/shared";
import { makeOrchestrator } from "../testing/fakes";

// A full disk fails every SQLite write, including the one that records a run's end. These
// cover the run (and the ticket's "working" spinner) getting stuck in `running` after that.

function setup(opts: Parameters<typeof makeOrchestrator>[0] = {}) {
  const h = makeOrchestrator(opts);
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, project, events };
}

/** Make the next `n` runs.finish calls throw like SQLite does when the disk is full. */
function failFinishes(h: ReturnType<typeof setup>, n: number) {
  const finish = h.store.runs.finish.bind(h.store.runs);
  let left = n;
  h.store.runs.finish = (...args: Parameters<typeof finish>) => {
    if (left > 0) {
      left--;
      throw new Error("database or disk is full");
    }
    return finish(...args);
  };
}

const statuses = (h: ReturnType<typeof setup>, sessionId: string) =>
  h.store.transcript
    .list(sessionId)
    .filter((e) => e.content.type === "status")
    .map((e) => (e.content as { text: string }).text);

test("a crash whose end can't be recorded stays busy only until reconcileRuns can write it", async () => {
  const h = setup();
  failFinishes(h, 2); // execute's finish and the onError retry
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /nosubmit" });
  await h.orch.idle();

  const [run] = h.store.runs.listBySession(t.sessionId);
  expect(run!.status).toBe("running");
  expect(h.orch.ticketDetail(t.key).ticket.busy).toBe(true);

  expect(h.orch.reconcileRuns()).toBe(1);
  const fixed = h.store.runs.get(run!.id)!;
  expect(fixed.status).toBe("failed");
  expect(fixed.endedAt).not.toBeNull();
  expect(h.orch.ticketDetail(t.key).ticket.busy).toBe(false);
  expect(h.events.some((e) => e.kind === "run.upserted" && e.run.id === run!.id && e.run.status === "failed")).toBe(true);
  expect(statuses(h, t.sessionId)).toContain("Run interrupted (work): the run ended without recording a result");
  expect(h.orch.reconcileRuns()).toBe(0);
});

test("a crash is recorded as failed right away once the retry can write", async () => {
  const h = setup();
  failFinishes(h, 1);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /nosubmit" });
  await h.orch.idle();

  const [run] = h.store.runs.listBySession(t.sessionId);
  expect(run!.status).toBe("failed");
  expect(run!.error).toBe("database or disk is full");
  expect(h.orch.ticketDetail(t.key).ticket.busy).toBe(false);
});

test("the session takes new runs after a crash instead of piling up `running` rows", async () => {
  const h = setup();
  failFinishes(h, 1);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "first /nosubmit" });
  await h.orch.idle();
  await h.orch.sendMessage(t.key, "second /nosubmit");
  await h.orch.idle();
  const runs = h.store.runs.listBySession(t.sessionId).filter((r) => r.kind === "work");
  expect(runs.map((r) => r.status)).toEqual<RunStatus[]>(["failed", "succeeded"]);
});

test("a failing transcript write fails the run and closes the driver so the agent process stops", async () => {
  const h = setup();
  let closed = false;
  h.driver.script = async function* () {
    try {
      yield { type: "text", text: "working on it" };
      await new Promise(() => {}); // the agent would keep going
    } finally {
      closed = true;
    }
  };
  const append = h.store.transcript.append.bind(h.store.transcript);
  h.store.transcript.append = (sessionId, runId, role, content, subagentId) => {
    if (role === "assistant" && content.type === "text") throw new Error("database or disk is full");
    return append(sessionId, runId, role, content, subagentId);
  };
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
  await h.orch.idle();

  expect(closed).toBe(true);
  const [run] = h.store.runs.listBySession(t.sessionId);
  expect(run!.status).toBe("failed");
  expect(run!.error).toBe("database or disk is full");
});

test("reconcileRuns leaves a live run and the run queued behind it alone", async () => {
  const h = setup();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "long /hold /nosubmit" });
  await Bun.sleep(5);
  await h.orch.sendMessage(t.key, "queued /nosubmit");

  expect(h.orch.reconcileRuns()).toBe(0);
  expect(h.store.runs.listBySession(t.sessionId).map((r) => r.status)).toEqual<RunStatus[]>(["running", "queued"]);

  h.driver.release();
  await h.orch.idle();
  const work = h.store.runs.listBySession(t.sessionId).filter((r) => r.kind === "work");
  expect(work.map((r) => r.status)).toEqual<RunStatus[]>(["succeeded", "succeeded"]);
});

test("a complete run cut off by a restart puts the approval back, and approving again lands the ticket", async () => {
  const h = setup();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
  await h.orch.idle();
  // The previous process approved it and started the complete run, then died.
  h.store.tickets.update(t.id, { humanReview: "approved" });
  const orphan = h.store.runs.create({ sessionId: t.sessionId, kind: "complete", driver: "fake", prompt: "p" });
  h.store.runs.markRunning(orphan.id);

  expect(h.orch.recoverStaleRuns()).toBe(1);
  expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
  expect(statuses(h, t.sessionId)).toContain("Completion interrupted: approve again to land it");

  h.orch.humanReview(t.key, { decision: "approve" });
  await h.orch.idle();
  expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
});

test("an interrupted run of another kind leaves the human's approval alone", async () => {
  const h = setup();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x [hold-review]" });
  while (h.driver.holding === 0) await Bun.sleep(1);
  h.orch.humanReview(t.key, { decision: "approve" });
  const orphan = h.store.runs.create({ sessionId: t.sessionId, kind: "chat", driver: "fake", prompt: "p" });
  h.store.runs.markRunning(orphan.id);
  expect(h.orch.reconcileRuns()).toBe(1);
  expect(h.orch.ticketDetail(t.key).ticket.humanReview).toBe("approved");
  h.driver.release();
  await h.orch.idle();
  expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
});

test("start() reconciles orphaned runs on a timer until stop()", async () => {
  const h = setup({ reconcileIntervalMs: 10 });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /nosubmit" });
  await h.orch.idle();
  h.orch.start();
  // Orphaned after start(), so the startup recovery can't be what fixes it.
  const orphan = h.store.runs.create({ sessionId: t.sessionId, kind: "work", driver: "fake", prompt: "p" });
  h.store.runs.markRunning(orphan.id);

  for (let i = 0; i < 50 && h.store.runs.get(orphan.id)!.status === "running"; i++) await Bun.sleep(10);
  expect(h.store.runs.get(orphan.id)!.status).toBe("failed");

  await h.orch.stop();
  const later = h.store.runs.create({ sessionId: t.sessionId, kind: "work", driver: "fake", prompt: "p" });
  h.store.runs.markRunning(later.id);
  await Bun.sleep(50);
  expect(h.store.runs.get(later.id)!.status).toBe("running");
});
