// The Spec tab's history bar: which revision it shows. `pinned` is null while it follows the
// newest revision (a spec.revised moves it along); scrubbing back pins it, and coming back to
// the newest one follows again.

export interface SpecHistory {
  /** The revision the user scrubbed to, or null to follow the newest */
  pinned: number | null;
}

export const FOLLOW_LATEST: SpecHistory = { pinned: null };

/** The revision on show: the pinned one (never past the newest), else the newest. */
export function shownRevision(h: SpecHistory, latest: number): number {
  return h.pinned === null ? latest : Math.max(1, Math.min(h.pinned, latest));
}

/** Go to `rev` (clamped to 1…latest); the newest revision follows live again. */
export function scrubTo(rev: number, latest: number): SpecHistory {
  const r = Math.max(1, Math.min(Math.round(rev), latest));
  return r >= latest ? FOLLOW_LATEST : { pinned: r };
}

/**
 * The revision under a pointer `x` px into the revision timeline, a `width` px strip split into
 * `latest` equal segments: off either end clamps to the first or newest.
 */
export function revisionAt(x: number, width: number, latest: number): number {
  if (latest <= 1 || !(width > 0)) return Math.max(1, latest);
  return Math.max(1, Math.min(latest, Math.floor((x / width) * latest) + 1));
}

/**
 * How the timeline draws one revision's segment. Segments are neutral: the ones up to the
 * revision on show read as passed, the rest as still ahead. Only the revision on show and the
 * approved plan are marked, and the one on show wins when it's also the approved plan.
 */
export type SegmentTone = "shown" | "baseline" | "before" | "after";

export function segmentTone(rev: number, shown: number, baseline: number | null | undefined): SegmentTone {
  if (rev === shown) return "shown";
  if (rev === baseline) return "baseline";
  return rev < shown ? "before" : "after";
}

/** Scroll distance (px) that moves the timeline one revision. */
export const WHEEL_STEP = 40;

/**
 * Scrolling over the history bar scrubs: down or right is newer, up or left older, along
 * whichever axis moved more. `carry` is the scroll left over from earlier events (a trackpad sends
 * many small ones). At either end the extra scroll is dropped, so scrolling back moves at once.
 */
export function wheelScrub(carry: number, dx: number, dy: number, shown: number, latest: number, step = WHEEL_STEP): { rev: number; carry: number } {
  const total = carry + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
  const steps = Math.trunc(total / step);
  const target = shown + steps;
  const rev = Math.max(1, Math.min(latest, target));
  return { rev, carry: rev === target ? total - steps * step : 0 };
}
