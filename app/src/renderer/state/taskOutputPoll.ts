// Reading a background task's output while its view is open (DESIGN.md "Background tasks"): the
// tail first, then what follows it every `intervalMs` while the task runs, one request at a time.
// Once the task has finished, one more read picks up its last lines and the polling stops.

import type { TaskOutput } from "@harness/shared";

export interface TaskOutputPoll {
  /** The task's status may have changed: a waiting poll reads now if it just finished. */
  wake(): void;
  stop(): void;
}

export function pollTaskOutput(opts: {
  /** GET …/output: the tail without an offset, else what follows it */
  read: (offset?: number) => Promise<TaskOutput>;
  running: () => boolean;
  onOutput: (out: TaskOutput) => void;
  onError?: (e: Error) => void;
  intervalMs: number;
}): TaskOutputPoll {
  let offset: number | undefined;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number) => {
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, ms);
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    // A read that starts after the task finished sees all of its output: it's the last one.
    const wasRunning = opts.running();
    inFlight = true;
    let finished = !wasRunning;
    try {
      const out = await opts.read(offset);
      if (stopped) return;
      if (out.available) offset = out.end;
      opts.onOutput(out);
      if (out.done) finished = true;
    } catch (e) {
      if (!stopped) opts.onError?.(e as Error);
    } finally {
      inFlight = false;
    }
    if (stopped || finished) return;
    // It finished while that read was out: read the rest right away.
    schedule(opts.running() ? opts.intervalMs : 0);
  };

  void tick();

  return {
    wake() {
      if (stopped || !timer || opts.running()) return;
      clearTimeout(timer);
      timer = null;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
