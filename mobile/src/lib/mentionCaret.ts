// The caret bookkeeping behind @-mention and /command autocomplete (ui/mentions.tsx), apart from
// React: where the caret is, and the selection the input is forced to after a pick so the caret
// lands after the inserted mention or command.

import { activeCommand, activeMention, type ActiveCommand, type ActiveMention } from "@harness/shared";

export interface Caret {
  /** The collapsed caret, or null for no caret or a range selection. */
  at: number | null;
  /** The selection forced on the input after a pick, until the input reports a newer one. */
  forced: number | null;
  /** While forced: the caret from before the pick, which iOS may report once more. */
  stale: number | null;
}

export const NO_CARET: Caret = { at: null, forced: null, stale: null };

/**
 * The input reported a selection. A range means no mention. A stale report of the caret from
 * before the pick (iOS sends one) keeps the forced selection; any other report releases it. iOS
 * doesn't always report the forced caret itself, and holding it until then would pin the caret
 * there, so each typed character would land before the last one.
 */
export function onSelection(c: Caret, start: number, end: number): Caret {
  const keep = c.forced !== null && start === end && start === c.stale && start !== c.forced;
  return keep ? c : { at: start === end ? start : null, forced: null, stale: null };
}

/** A pick replaced the mention (the caret was at `before`): the caret goes after it, and the input is held there. */
export const onPick = (caret: number, before: number | null = null): Caret => ({ at: caret, forced: caret, stale: before });

/** The mention being typed at the caret, if any (the caret can outrun a value that was just replaced). */
export function mentionAt(value: string, c: Caret): ActiveMention | null {
  return c.at === null || c.at > value.length ? null : activeMention(value, c.at);
}

/** The /command being typed at the caret, if any. */
export function commandAt(value: string, c: Caret): ActiveCommand | null {
  return c.at === null || c.at > value.length ? null : activeCommand(value, c.at);
}

/** The TextInput's controlled selection: only while one is forced. */
export const selectionProp = (c: Caret) => (c.forced === null ? undefined : { start: c.forced, end: c.forced });
