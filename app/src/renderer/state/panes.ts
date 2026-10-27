// The pane store: every scope's PaneState kept in localStorage and shared with React. The pure
// operations (docking, closing, resizing, parsing) live in paneModel.ts and are re-exported here.

import { useMemo, useSyncExternalStore } from "react";
import { parsePaneStore, isPopoutScope, defaultPanes, bareBoardId, serializePaneStore, withScope, popoutPanes, popOut, dropInStore, popOutContent, returnTab, tornOffTabs, popIn, retainPopouts, mapScopes, rekeyScopes, retainScopes, forgetProject, popoutScope, type DragSource, type DropTarget, type PaneContent, type PaneState, type PaneStore, type TornOff } from "./paneModel";

export * from "./paneModel";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const PANES_KEY = "harness.panes";

function load(): PaneStore {
  try {
    return parsePaneStore(localStorage.getItem(PANES_KEY));
  } catch {
    return { scopes: {} };
  }
}

let current: PaneStore | null = null;
const listeners = new Set<() => void>();
const getStore = () => (current ??= load());

/** A scope's panes. One that isn't stored yet gets a bare board, kept in memory until it's first changed. */
function get(scope: string): PaneState {
  const store = getStore();
  // A pop-out that's gone stays gone (a bare board isn't a pop-out).
  if (isPopoutScope(scope)) return store.scopes[scope] ?? NO_POPOUT;
  return (store.scopes[scope] ??= defaultPanes(bareBoardId(scope)));
}
const NO_POPOUT: PaneState = defaultPanes("b:popout");

function publish(next: PaneStore) {
  current = next;
  for (const fn of listeners) fn();
}

/** Write the whole store (every scope) unless `next` is the store as it is. */
function commit(next: PaneStore) {
  if (next === getStore()) return;
  try {
    localStorage.setItem(PANES_KEY, serializePaneStore(next));
  } catch {}
  publish(next);
}

/** Apply an operation to one scope (e.g. `updatePanes(scope, (s) => openTicket(s, key))`); a no-op returning the same state writes nothing. */
export function updatePanes(scope: string, fn: (s: PaneState) => PaneState) {
  if (isPopoutScope(scope)) {
    // A pop-out keeps just its pane, and goes when that closes (its window follows).
    const prev = getStore().scopes[scope];
    if (prev) commit(withScope(getStore(), scope, popoutPanes(fn(prev))));
    return;
  }
  const prev = get(scope);
  const next = fn(prev);
  if (next !== prev) commit({ scopes: { ...getStore().scopes, [scope]: next } });
}

/** Pop a pane out (see popOut); false when it didn't (nothing to open a window for). */
export function popOutPane(scope: string, leafId: string, id: string): boolean {
  get(scope);
  const before = getStore();
  commit(popOut(before, scope, leafId, id));
  return getStore() !== before;
}

/** A drop on board `scope` (see dropInStore). */
export function dropOnBoard(scope: string, source: DragSource, targetLeafId: string, zone: DropTarget) {
  commit(dropInStore(getStore(), scope, source, targetLeafId, zone));
}

/** Open `content` in the pop-out `id` (see popOutContent); false when it didn't. */
export function popOutContentPane(boardScope: string, content: PaneContent, id: string): boolean {
  const before = getStore();
  commit(popOutContent(before, boardScope, content, id));
  return getStore() !== before;
}

/** Return to this window (see returnTab). */
export function returnTabPane(boardScope: string, ticketKey: string, id: string) {
  commit(returnTab(getStore(), boardScope, ticketKey, id));
}

/** The whole store, as a React value (re-renders on every change). */
export function usePaneStore(): PaneStore {
  return useSyncExternalStore(subscribe, getStore);
}

/** Which of `ticketKey`'s tabs are torn off, as board `boardScope` sees them (see tornOffTabs). */
export function useTornOffTabs(ticketKey: string, boardScope: string): Map<string, TornOff> {
  const store = usePaneStore();
  return useMemo(() => tornOffTabs(store, ticketKey, boardScope), [store, ticketKey, boardScope]);
}

/** Put a popped-out pane back on `toScope`'s board (see popIn). */
export function popInPane(id: string, toScope: string) {
  commit(popIn(getStore(), id, toScope));
}

/** Forget the pop-outs whose windows aren't open (`open` = their ids); a terminal in one is closed with it. */
export function retainPopoutPanes(open: ReadonlySet<string>) {
  commit(retainPopouts(getStore(), (id) => open.has(id)));
}

/** A pop-out's window was closed: its pane closes too. */
export function closePopoutPane(id: string) {
  commit(retainPopouts(getStore(), (other) => other !== id));
}

/** Apply an operation to every scope (a ticket deleted or renamed can be open in several). */
export function updateAllPanes(fn: (s: PaneState) => PaneState) {
  commit(mapScopes(getStore(), fn));
}

/** Drop the scopes `keep` rejects (projects that no longer exist). */
export function retainPaneScopes(keep: (scope: string) => boolean) {
  commit(retainScopes(getStore(), keep));
}

/** Move scopes to new keys (see rekeyScopes). */
export function rekeyPaneScopes(rekey: (scope: string) => string) {
  commit(rekeyScopes(getStore(), rekey));
}

/** A project was removed (see forgetProject). */
export function forgetProjectPanes(projectId: string, projectKey: string | null) {
  commit(forgetProject(getStore(), projectId, projectKey));
}

/**
 * Re-read the stored panes (another window wrote them). This window's New session panes aren't
 * stored, so they go with it; anything typed in one is already a draft ticket, whose pane is.
 */
export const reloadPanes = () => publish(load());

/** The panes as stored, without adopting them (e.g. to see another window's terminals). */
export const storedPaneStore = (): PaneStore => load();

/** The whole store (every scope), for things that span scopes like the terminal lifecycle. */
export const getPaneStore = (): PaneStore => getStore();

/**
 * Call `fn(before, after)` whenever the store changes (in this window, or re-read after another
 * window wrote it). Returns an unsubscribe.
 */
export function watchPaneStore(fn: (before: PaneStore, after: PaneStore) => void): () => void {
  let prev = getStore();
  return subscribe(() => {
    const next = getStore();
    if (next === prev) return;
    const before = prev;
    prev = next;
    fn(before, next);
  });
}

let started = false;
function subscribe(fn: () => void) {
  if (!started) {
    started = true;
    // Another window (or a test/screenshot setup) changed it: follow.
    globalThis.addEventListener?.("storage", (e: StorageEvent) => {
      if (e.key === PANES_KEY || e.key === null) reloadPanes();
    });
  }
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** A scope's current panes outside React (e.g. an effect checking that its render isn't already stale). */
export const getPanes = (scope: string): PaneState => get(scope);

export function usePanes(scope: string): PaneState {
  return useSyncExternalStore(subscribe, () => get(scope));
}

/** A pop-out's panes, or null once it's gone (its pane was closed or went back to a board). */
export const getPopoutPanes = (id: string): PaneState | null => getStore().scopes[popoutScope(id)] ?? null;

export function usePopoutPanes(id: string): PaneState | null {
  return useSyncExternalStore(subscribe, () => getPopoutPanes(id));
}
