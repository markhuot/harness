// Activity entries are one short line each (DESIGN.md "Activity"): the at-a-glance progress on
// board cards, a conductor's Tickets tab, search and the Activity tab. Agent-written notes are
// held to it (oneLineError); text the service writes from longer sources is summarized
// (activityLine), with the full text in meta.detail where it matters.

/** The longest an Activity line may be. */
export const ACTIVITY_LINE_MAX = 400;

/**
 * `text` as one Activity line: its first non-empty line without a leading heading, list or
 * quote marker, whitespace collapsed, cut at `max` characters on a word boundary with "…".
 */
export function activityLine(text: string, max = ACTIVITY_LINE_MAX): string {
  const first = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+/, "").replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (!first) return "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Why `text` can't be an agent's Activity note (more than one line, or longer than
 * ACTIVITY_LINE_MAX), as the error the agent reads; null when it's fine. `what` names the field,
 * e.g. "The note".
 */
export function oneLineError(what: string, text: string): string | null {
  const t = text.trim();
  const lines = t.split(/\r?\n/).filter((l) => l.trim()).length;
  if (lines <= 1 && t.length <= ACTIVITY_LINE_MAX) return null;
  const size = lines > 1 ? `${lines} lines` : `${t.length} characters`;
  return `${what} goes into the ticket's Activity, so it must be one short line (no line breaks, at most ${ACTIVITY_LINE_MAX} characters); this one is ${size}. Say what changed and why in one sentence and call again. Detail belongs in the spec (edit_spec) or stays in the transcript.`;
}
