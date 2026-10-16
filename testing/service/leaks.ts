/**
 * Finds the timers a module under test leaves running. A timer that's still pending after the test
 * has stopped what it was testing is a leak: it shows up here as a failure with where it was
 * started, instead of as a slow exit or a callback firing into the next test.
 *
 * `trackTimers` wraps the global timer functions once and starts a new count; `assertNoTimerLeaks` fails for every
 * interval, and every timeout that can still fire, that was started since the last check and is
 * neither cleared nor unref'd (an unref'd timer doesn't hold the process open, and the product marks
 * the ones it means to leave: the 3 s SIGKILL after a hang-up, the APNs socket). It clears what it
 * found so one leak fails one test.
 */
interface Pending {
  timer: { hasRef?: () => boolean };
  kind: "timeout" | "interval";
  delay: number;
  stack: string;
}

const pending = new Map<unknown, Pending>();
let installed = false;

export function trackTimers() {
  // A fresh start: timers other tests left behind are theirs, not this one's.
  pending.clear();
  if (installed) return;
  installed = true;
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;
  const where = () => (new Error().stack ?? "").split("\n").slice(3, 6).map((l) => l.trim()).join(" <- ");
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = realSetTimeout(((...a: unknown[]) => {
      pending.delete(timer);
      fn(...a);
    }) as never, delay, ...args) as unknown as Pending["timer"];
    pending.set(timer, { timer, kind: "timeout", delay: delay ?? 0, stack: where() });
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = realSetInterval(fn as never, delay, ...args) as unknown as Pending["timer"];
    pending.set(timer, { timer, kind: "interval", delay: delay ?? 0, stack: where() });
    return timer;
  }) as unknown as typeof setInterval;
  globalThis.clearTimeout = ((timer: unknown) => {
    pending.delete(timer);
    return realClearTimeout(timer as never);
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((timer: unknown) => {
    pending.delete(timer);
    return realClearInterval(timer as never);
  }) as typeof clearInterval;
}

/** Throws, naming where each was started, if a ref'd timer started since the last call is still pending. */
export function assertNoTimerLeaks() {
  const leaked: string[] = [];
  for (const [timer, p] of pending) {
    pending.delete(timer);
    if (p.timer.hasRef && !p.timer.hasRef()) continue;
    leaked.push(`${p.kind} (${p.delay}ms) started at ${p.stack}`);
    (p.kind === "interval" ? clearInterval : clearTimeout)(timer as never);
  }
  if (leaked.length) throw new Error(`Timers still pending after the test:\n${leaked.join("\n")}`);
}
