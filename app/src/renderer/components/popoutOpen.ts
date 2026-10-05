// Opening pop-out windows from the renderer: popping a pane out (its header button, ⇧⌘O, dragging
// its grip out of the window), opening content straight into a window (dragging a card, a tab or
// the composer out, Open in New Window), and putting a pop-out back on its board. The store side is
// state/panes.ts ("Pop-out windows"); main.ts owns the windows.

import type { Project } from "@harness/shared";
import { ALL_SCOPE, scopeProject } from "@harness/shared/state";
import {
  canPopOut,
  findLeaf,
  getPanes,
  getPaneStore,
  isPopoutScope,
  popInPane,
  popOutContentPane,
  popOutPane,
  leaves,
  popoutIdOf,
  popoutScope,
  popoutShowing,
  type PaneContent,
  type PaneState,
} from "../state/panes";

const leavesOf = (s: PaneState) => leaves(s.root).map((l) => l.id);
import { formatRoute } from "../state/route";
import type { PopoutInfo } from "./paneContext";
import { paneElement } from "./paneFocus";

/** A point on the screen (a drag released outside the window), where a pop-out opens under the pointer. */
export type ScreenPoint = { x: number; y: number };

/** A pane's box on the screen, which a pop-out of it opens over. */
function screenBoxOf(paneId: string | undefined) {
  const r = paneId ? paneElement(paneId)?.getBoundingClientRect() : undefined;
  return r && { x: Math.round(window.screenX + r.left), y: Math.round(window.screenY + r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/**
 * Pop the pane `paneId` of `scope` out into a window of its own, opened over the spot the pane
 * had, or under `at`. False when there's nothing to pop out (the board, a New session, no desktop app).
 */
export function popOutToWindow(scope: string, paneId: string, at?: ScreenPoint): boolean {
  const bridge = window.harness?.popout;
  const leaf = findLeaf(getPanes(scope).root, paneId);
  if (!bridge || !leaf || !canPopOut(leaf.content) || isPopoutScope(scope)) return false;
  const bounds = screenBoxOf(paneId);
  const id = crypto.randomUUID();
  if (!popOutPane(scope, paneId, id)) return false;
  // No window came up: put the pane back where it was, rather than leave it nowhere.
  bridge.open({ id, route: formatRoute({ view: "popout", id, fromScope: scope }), bounds, ...(at ? { at } : {}) }).catch(() => popInPane(id, scope));
  return true;
}

/**
 * Open `content` in a window of its own (popOutContent): a pane that already shows it on board
 * `boardScope` moves out, and a window that already shows it comes forward. Opens under `at` when
 * given, else over the pane it came from. False when there's nothing to open (the board, no app).
 */
export function popOutContentToWindow(boardScope: string, content: PaneContent, at?: ScreenPoint): boolean {
  const bridge = window.harness?.popout;
  if (!bridge || !canPopOut(content) || isPopoutScope(boardScope)) return false;
  const store = getPaneStore();
  const there = popoutShowing(store, content);
  if (there) {
    // Already a window: opening its id again just brings it forward.
    const id = popoutIdOf(there.scope);
    void bridge.open({ id, route: formatRoute({ view: "popout", id, fromScope: boardScope }) });
    return true;
  }
  const id = crypto.randomUUID();
  const before = getPanes(boardScope);
  // Measured before it moves: a pane already showing it, which the window opens over without a pointer.
  const moved = (leaf: string | null | undefined) => (leaf && findLeaf(before.root, leaf) ? leaf : undefined);
  const boxes = new Map(leavesOf(before).map((l) => [l, screenBoxOf(l)]));
  if (!popOutContentPane(boardScope, content, id)) return false;
  const leafId = moved(getPaneStore().scopes[popoutScope(id)]?.focusedId);
  const bounds = leafId ? boxes.get(leafId) : undefined;
  bridge.open({ id, route: formatRoute({ view: "popout", id, fromScope: boardScope }), ...(bounds ? { bounds } : {}), ...(at ? { at } : {}) }).catch(() => popInPane(id, boardScope));
  return true;
}

/**
 * Put a pop-out's pane back on the board it came from (All projects if that project is gone), and
 * bring the main window forward on that board. The pop-out window closes once its pane is gone.
 */
export function popBackIn({ id, fromScope }: PopoutInfo, projects: Readonly<Record<string, Project>>) {
  const to = fromScope === ALL_SCOPE || projects[fromScope] ? fromScope : ALL_SCOPE;
  popInPane(id, to);
  void window.harness?.popout.showMain(formatRoute({ view: "board", projectId: scopeProject(to) ?? null, ticketKey: null, tab: "spec" }));
}
