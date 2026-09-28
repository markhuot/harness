// Keeping DOM focus with pane focus. The store's focusedId says which pane the keyboard acts on;
// when a keyboard command moves it (⌥⌘arrows, Enter on a card, closing a pane), the DOM focus
// follows into that pane: to what last had focus there, else its [data-pane-autofocus] element
// (the board's cursor card, a ticket's active tab), else the pane itself. Pointer focus needs none
// of this, the click already put the focus where it belongs.

import { getPanes, updatePanes, type PaneState } from "../state/panes";

const lastFocused = new Map<string, HTMLElement>();
let pending = false;

/** Ask the workspace to move DOM focus into the focused pane once the store change renders. */
export const requestPaneFocus = () => void (pending = true);

/** True once per request (the workspace calls this after each focusedId change). */
export function takePaneFocusRequest(): boolean {
  const p = pending;
  pending = false;
  return p;
}

/** Remember where focus was inside a pane (focusin), to come back to it. */
export const rememberPaneFocus = (paneId: string, el: HTMLElement) => void lastFocused.set(paneId, el);

export const paneElement = (paneId: string) => document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(paneId)}"]`);

const visible = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0 && !el.closest("[inert], [aria-hidden=true]");

/** Move DOM focus into a pane. A terminal focuses its own screen. */
export function focusPaneDom(paneId: string): boolean {
  const pane = paneElement(paneId);
  if (!pane) return false;
  const host = [...pane.querySelectorAll<HTMLElement & { harnessTerminal?: { focus(): void } }>("[data-terminal] *")].find((n) => n.harnessTerminal);
  if (host?.harnessTerminal) {
    host.harnessTerminal.focus();
    return true;
  }
  const last = lastFocused.get(paneId);
  const target = last && pane.contains(last) && visible(last) ? last : [...pane.querySelectorAll<HTMLElement>("[data-pane-autofocus]")].find(visible) ?? pane;
  target.focus();
  return true;
}

/** Focus the sidebar's current item (its roving tabindex stop), or its first. */
export function focusSidebar(): boolean {
  const side = document.getElementById("app-sidebar");
  if (!side || side.hasAttribute("inert")) return false;
  const el = side.querySelector<HTMLElement>('[data-roving-item][tabindex="0"]') ?? side.querySelector<HTMLElement>("[data-roving-item], .nav-item");
  el?.focus();
  return !!el;
}

/**
 * Apply a pane operation from the keyboard and move DOM focus to the pane that's focused after it
 * (a new one renders first, so the workspace does it; an unchanged store is done right away).
 */
export function focusPaneBy(scope: string, fn: (s: PaneState) => PaneState) {
  const before = getPanes(scope);
  pending = true;
  updatePanes(scope, fn);
  const after = getPanes(scope);
  if (after !== before) return;
  pending = false;
  if (after.focusedId) focusPaneDom(after.focusedId);
}
