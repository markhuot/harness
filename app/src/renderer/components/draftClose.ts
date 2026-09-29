// Closing a pane that holds a draft (a New session pane, or a draft ticket's pane) goes through
// its editor (views/DraftEditor.tsx): an empty draft just closes (a saved one is deleted), anything
// else asks "Close this draft?" first. Every way of closing a pane asks here: the pane's ✕, ⌘W and
// Escape (paneCommands.ts), and its More menu. Other panes aren't registered and close as usual.

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
