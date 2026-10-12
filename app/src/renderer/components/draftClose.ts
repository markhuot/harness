// Closing a pane that holds a draft (a New session pane, or a draft ticket's pane) goes through
// its editor (views/DraftEditor.tsx): an empty draft just closes (a saved one is deleted), anything
// else asks "Close this draft?" first. A file pane with unsaved edits registers too (views/FilePane.tsx):
// it saves or asks first. Every way of closing a pane asks here: the pane's ✕, ⌘W and Escape
// (paneCommands.ts), and its More menu. Other panes aren't registered and close as usual.

import { closePane, updatePanes } from "../state/panes";
import { focusPaneBy } from "./paneFocus";

const closers = new Map<string, (keyboard: boolean) => void>();

/** A draft editor takes over closing its pane. Returns the unregister. */
export function registerDraftCloser(leafId: string, close: (keyboard: boolean) => void): () => void {
  closers.set(leafId, close);
  return () => {
    if (closers.get(leafId) === close) closers.delete(leafId);
  };
}

/** Whether closing this pane has to ask its draft editor first. */
export const hasDraftCloser = (leafId: string) => closers.has(leafId);

/**
 * Close a pane: through its draft editor when it has one (requestCloseDraft), else right away.
 * `keyboard` moves the DOM focus with the pane focus (⌘W, Escape).
 */
export function requestClosePane(scope: string, leafId: string, keyboard = false) {
  const draft = closers.get(leafId);
  if (draft) return draft(keyboard);
  if (keyboard) focusPaneBy(scope, (s) => closePane(s, leafId));
  else updatePanes(scope, (s) => closePane(s, leafId));
}

// A pane with unsaved edits that's about to change under them without closing (another file replacing
// it, a move, a pop-out) asks first, here, while the user can still say Cancel: once React has
// unmounted the pane it's too late. A guard answers whether the change may go ahead.
const guards = new Map<string, () => boolean>();

/** A pane with unsaved edits asks before it's replaced or moved. Returns the unregister. */
export function registerLeaveGuard(leafId: string, guard: () => boolean): () => void {
  guards.set(leafId, guard);
  return () => {
    if (guards.get(leafId) === guard) guards.delete(leafId);
  };
}

/** Whether these panes can be replaced or moved: each one with unsaved edits has saved, been told to discard them, or is leaving as they are. */
export function confirmLeave(leafIds: Iterable<string>): boolean {
  for (const id of leafIds) if (guards.get(id)?.() === false) return false;
  return true;
}
