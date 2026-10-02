// The Spec tab's history bar: which revision it shows. `pinned` is null while it follows the
// newest revision (a spec.revised moves it along); stepping or scrubbing back pins it, and
// coming back to the newest one follows again.

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

/** ← / → : one revision back or forward from the one on show. */
export function stepRevision(h: SpecHistory, latest: number, delta: number): SpecHistory {
  return scrubTo(shownRevision(h, latest) + delta, latest);
}

/**
 * The service's diff headers name the ticket and revisions ("HARNESS-1 spec rev 2"); the diff
 * viewer takes the first two lines as a file name, so they become one markdown file it can
 * highlight.
 */
export function specDiffPatch(diff: string): string {
  if (!diff) return "";
  const lines = diff.split("\n");
  if (lines[0]?.startsWith("--- ") && lines[1]?.startsWith("+++ ")) lines.splice(0, 2, "--- a/spec.md", "+++ b/spec.md");
  return lines.join("\n");
}
