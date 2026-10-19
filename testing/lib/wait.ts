// Waiting without sleeping: every wait is on something observable and has a deadline. A deadline
// is a failure bound, not a pause: it turns a hang into an error that names the step and the last
// thing seen.

export class DeadlineError extends Error {
  constructor(readonly what: string, readonly ms: number, readonly lastSeen: string) {
    super(`timed out after ${ms}ms waiting for ${what}; last seen: ${lastSeen}`);
    this.name = "DeadlineError";
  }
}

/** What a deadline error prints for the last observed state: short, one line, never empty. */
export function describeState(state: unknown): string {
  if (state === undefined) return "nothing yet";
  const text = typeof state === "string" ? state : JSON.stringify(state);
  const flat = (text ?? String(state)).replace(/\s+/g, " ").trim();
  if (flat === "") return "an empty value";
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/**
 * Settle with `promise`, or reject with a DeadlineError once `ms` have passed. `last()` reports
 * the last observed state when the deadline hits. The timer is cleared as soon as the promise settles.
 */
export function withDeadline<T>(what: string, ms: number, promise: Promise<T>, last: () => unknown = () => undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(what, ms, describeState(last()))), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Call `probe` back to back until it returns something other than `undefined`/`false`/`null`.
 * For probes that are themselves slow to answer (an AXe describe, a CDP evaluate): the probe's own
 * duration paces the loop, and the deadline bounds it. Anything with an event to wait on uses it instead.
 * A probe that takes longer than the deadline (an AXe describe on a loaded Mac) has still only looked
 * once, and one look that missed doesn't show the thing never came: the deadline doesn't fail the wait
 * before `minProbes` probes have answered.
 */
export async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | false | null> | T | undefined | false | null, minProbes = 1): Promise<T> {
  const deadline = performance.now() + ms;
  let last: unknown;
  for (let probes = 1; ; probes++) {
    const seen = await probe();
    if (seen !== undefined && seen !== false && seen !== null) return seen;
    last = seen;
    if (probes >= minProbes && performance.now() >= deadline) throw new DeadlineError(what, ms, describeState(last));
    // Let queued events (sockets, child output) run between probes.
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** A promise settled from outside, for turning callbacks (child output, socket messages) into something to await. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
