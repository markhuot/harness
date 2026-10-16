import { expect, test } from "bun:test";
import { RunQueue, type QueuedJob } from "../../../service/src/orchestrator/queue";

/** A job whose execution the test finishes by hand, so ordering is decided by the test, not a timer. */
function gated() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const errors: string[] = [];
  const queue = new RunQueue({
    limit: () => limit.n,
    execute: (job) => {
      started.push(job.runId);
      return new Promise<void>((resolve, reject) => {
        gates.set(job.runId, () => (job.runId.startsWith("bad") ? reject(new Error("boom")) : resolve()));
      });
    },
    onError: (job, err) => errors.push(`${job.runId}:${(err as Error).message}`),
  });
  const limit = { n: 2 };
  const job = (runId: string, sessionId: string, extra: Partial<QueuedJob> = {}): QueuedJob => ({ runId, sessionId, kind: "work", ...extra });
  const finish = async (runId: string) => {
    // The queue yields one microtask before executing a job; let it start.
    await Promise.resolve();
    await Promise.resolve();
    gates.get(runId)!();
    await queue.whenSessionIdle(sessionOf.get(runId)!);
  };
  const sessionOf = new Map<string, string>();
  const add = (runId: string, sessionId: string, extra: Partial<QueuedJob> = {}) => {
    sessionOf.set(runId, sessionId);
    queue.enqueue(job(runId, sessionId, extra));
  };
  return { queue, started, errors, limit, add, finish };
}

test("never runs more jobs at once than the limit, and starts the next in FIFO order when one ends", async () => {
  const { queue, started, add, finish } = gated();
  add("a", "s1");
  add("b", "s2");
  add("c", "s3");
  await Promise.resolve();
  expect(started).toEqual(["a", "b"]);
  expect(queue.runningCount).toBe(2);
  expect(queue.pendingCount).toBe(1);
  await finish("a");
  expect(started).toEqual(["a", "b", "c"]);
});

test("a session runs one job at a time even when the limit has room, and a later session isn't blocked behind it", async () => {
  const { queue, started, add, finish } = gated();
  add("a1", "s1");
  add("a2", "s1");
  add("b", "s2");
  await Promise.resolve();
  expect(started).toEqual(["a1", "b"]);
  expect(queue.pendingFor("s1").map((j) => j.runId)).toEqual(["a2"]);
  await finish("a1");
  expect(started).toContain("a2");
});

test("jobs sharing a lock are serialized across sessions", async () => {
  const { started, add, finish } = gated();
  add("m1", "s1", { lock: "checkout" });
  add("m2", "s2", { lock: "checkout" });
  add("free", "s3");
  await Promise.resolve();
  expect(started).toEqual(["m1", "free"]);
  await finish("m1");
  expect(started).toEqual(["m1", "free", "m2"]);
});

test("a failing job reports to onError and frees its slot", async () => {
  const { queue, started, errors, add, finish } = gated();
  add("bad1", "s1");
  add("ok", "s1");
  await Promise.resolve();
  await finish("bad1");
  expect(errors).toEqual(["bad1:boom"]);
  expect(started).toEqual(["bad1", "ok"]);
  expect(queue.runningFor("s1")?.runId).toBe("ok");
});

test("remove drops a pending job but cannot touch a running one", async () => {
  const { queue, add } = gated();
  add("a", "s1");
  add("b", "s1");
  await Promise.resolve();
  expect(queue.remove("b")).toBe(true);
  expect(queue.has("b")).toBe(false);
  expect(queue.remove("a")).toBe(false);
  expect(queue.has("a")).toBe(true);
});

test("idle resolves only once pending and running are both empty", async () => {
  const { queue, add, finish } = gated();
  let idle = false;
  add("a", "s1");
  add("b", "s1");
  void queue.idle().then(() => (idle = true));
  await finish("a");
  await Promise.resolve();
  expect(idle).toBe(false);
  await finish("b");
  await queue.idle();
  expect(idle).toBe(true);
});

test("pause stops new jobs from starting; pump resumes nothing until unpaused work arrives", async () => {
  const { queue, started, add } = gated();
  queue.pause();
  add("a", "s1");
  await Promise.resolve();
  expect(started).toEqual([]);
  expect(queue.pendingCount).toBe(1);
});

test("a limit of 0 still runs one job at a time rather than stalling", async () => {
  const { queue, started, limit, add } = gated();
  limit.n = 0;
  add("a", "s1");
  add("b", "s2");
  await Promise.resolve();
  expect(started).toEqual(["a"]);
  expect(queue.runningCount).toBe(1);
});
