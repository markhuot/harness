// The caret bookkeeping behind @-mention and /command autocomplete (ui/mentions.tsx), apart from
// React: where the caret is, and the selection the input is forced to after a pick so the caret
// lands after the inserted mention or command.

import { activeCommand, activeMention, type ActiveCommand, type ActiveMention } from "@harness/shared";

export interface Caret {
  /** The collapsed caret, or null for no caret or a range selection. */
  at: number | null;
  /** The selection forced on the input after a pick, until the input reports it. */
  forced: number | null;
}

export const NO_CARET: Caret = { at: null, forced: null };

/**
 * The input reported a selection. A range means no mention. The forced selection is released
 * once the input lands on it; a stale report from before the pick (iOS sends one) keeps it.
 */
export function onSelection(c: Caret, start: number, end: number): Caret {
  return { at: start === end ? start : null, forced: c.forced !== null && start === c.forced ? null : c.forced };
}

/** A pick replaced the mention: the caret goes after it, and the input is held there. */
export const onPick = (caret: number): Caret => ({ at: caret, forced: caret });

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
