// Run queue: FIFO, serialized per session, globally limited to `limit()` concurrent runs.

import type { RunKind } from "@harness/shared";

export interface QueuedJob {
  runId: string;
  sessionId: string;
  kind: RunKind;
}

export class RunQueue {
  private pending: QueuedJob[] = [];
  /** sessionId → running job */
  private running = new Map<string, { job: QueuedJob; done: Promise<void> }>();
  private idleWaiters: (() => void)[] = [];
  private paused = false;

  constructor(
    private opts: {
      limit: () => number;
      execute: (job: QueuedJob) => Promise<void>;
      onError?: (job: QueuedJob, err: unknown) => void;
    },
  ) {}

  enqueue(job: QueuedJob) {
    this.pending.push(job);
    this.pump();
  }

  /** Remove a job that hasn't started. Returns true if it was pending. */
  remove(runId: string): boolean {
    const i = this.pending.findIndex((j) => j.runId === runId);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    this.checkIdle();
    return true;
  }

  pendingFor(sessionId: string): QueuedJob[] {
    return this.pending.filter((j) => j.sessionId === sessionId);
  }

  runningFor(sessionId: string): QueuedJob | null {
    return this.running.get(sessionId)?.job ?? null;
  }

  /** Promise settling when the session's current run finishes (resolved if none). */
  whenSessionIdle(sessionId: string): Promise<void> {
    return this.running.get(sessionId)?.done ?? Promise.resolve();
  }

  get runningCount() {
    return this.running.size;
  }
  get pendingCount() {
    return this.pending.length;
  }

  /** Stop starting new jobs (used during shutdown). */
  pause() {
    this.paused = true;
  }

  pump() {
    if (this.paused) return;
    const limit = Math.max(1, this.opts.limit());
    for (let i = 0; i < this.pending.length && this.running.size < limit; ) {
      const job = this.pending[i]!;
      if (this.running.has(job.sessionId)) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      const done = this.start(job);
      this.running.set(job.sessionId, { job, done });
    }
    this.checkIdle();
  }

  private async start(job: QueuedJob): Promise<void> {
    // Yield so the caller's synchronous bookkeeping (running map) completes first.
    await Promise.resolve();
    try {
      await this.opts.execute(job);
    } catch (err) {
      this.opts.onError?.(job, err);
    } finally {
      this.running.delete(job.sessionId);
      this.pump();
    }
  }

  private checkIdle() {
    if (this.pending.length === 0 && this.running.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Resolves when nothing is pending or running. */
  idle(): Promise<void> {
    if (this.pending.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
