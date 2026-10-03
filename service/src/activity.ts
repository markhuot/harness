// Activity entries read as one line each (DESIGN.md "Activity"): the at-a-glance progress on
// board cards, a conductor's Tickets tab, search and the Activity tab. Nothing is refused or cut:
// an entry's body is the first line of what was written, and the whole text, when there's more,
// goes in meta.detail behind Show details. The prompts strongly recommend a single line of
// ACTIVITY_LINE_MAX characters or less, for quick scanning.

/** The length the prompts recommend an Activity line stay under. Not enforced. */
export const ACTIVITY_LINE_MAX = 400;

/**
 * `text` as one Activity line: its first non-empty line without a leading heading, list or quote
 * marker, whitespace collapsed. Never shortened.
 */
export function activityLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+/, "").replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? ""
  );
}
