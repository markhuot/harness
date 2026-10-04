// Dragging tickets, tabs and panes onto the pane workspace, or out of the window. Sources (board
// cards, conductor child rows, a pane's header grip, a ticket's tab buttons, browser chips and the
// composer's grip) call `dragProps`; while one of them is being dragged, the workspace shows a drop
// layer over every pane (PaneWorkspace.tsx) that previews and applies the drop through the pure
// helpers in state/panes.ts (zoneAt, dropTargetAt, applyDrop, dropInStore).
//
// A drag released outside the window with nothing taking it (state/dragOut.ts) pops what it carries
// out into a window of its own under the pointer: a pane grip its pane, a card or child row its
// ticket (the pane it's open in, if it is), a tab or the composer its torn-off pane. That lives
// here once, in dragProps' dragend, so every drag source gets it.
//
// The dragged thing is in the DataTransfer under our own types, so the layer can ignore drags that
// aren't ours (files, text) from `types` alone during dragover, when the data itself is hidden.
// It's also kept here, since dragover needs to know what's dragged to decide whether a drop
// would do anything.

import { useSyncExternalStore, type DragEvent, type MouseEvent } from "react";
import { dropOnBoard, findLeaf, getPanes, isPopoutScope, returnTabPane, splitTarget, tabContent, tornId, type DragSource, type DropZone, type PaneContent, type TabDrag, type TornOff } from "../state/panes";
import { dragOutPoint } from "../state/dragOut";
import { popOutContentToWindow, popOutToWindow, type ScreenPoint } from "./popoutOpen";

export const TICKET_MIME = "application/x-harness-ticket";
export const PANE_MIME = "application/x-harness-pane";
/** A ticket's tab, a browser chip or the composer: JSON `{ ticketKey, tab, browserTab? }`. */
export const TAB_MIME = "application/x-harness-ticket-tab";

let active: DragSource | null = null;
/** Bumped by every start and end, so a start deferred past its own end doesn't revive the drag. */
let generation = 0;
const listeners = new Set<() => void>();

function setActive(next: DragSource | null) {
  if (active === next) return;
  active = next;
  for (const fn of listeners) fn();
}

/** The harness drag in progress, or null. */
export function useActiveDrag(): DragSource | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => active,
  );
}

export function endDrag() {
  generation++;
  setActive(null);
}

// A drag ends with dragend on its source. If the source left the DOM mid-drag (a card changed
// column) that never reaches the window, but the first buttonless mouse move after the drag does.
addEventListener("dragend", endDrag, true);
addEventListener("drop", () => setTimeout(endDrag), true);
addEventListener("mousemove", (e: globalThis.MouseEvent) => active && e.buttons === 0 && endDrag(), true);

/** Whether a DataTransfer carries one of our drags (readable during dragover, unlike the data). */
export const isHarnessDrag = (dt: DataTransfer | null) => !!dt && (dt.types.includes(TICKET_MIME) || dt.types.includes(PANE_MIME) || dt.types.includes(TAB_MIME));

/** A TAB_MIME payload, checked; null when it isn't one. */
function parseTabDrag(raw: string): TabDrag | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.ticketKey !== "string" || !v.ticketKey || typeof v.tab !== "string" || !v.tab) return null;
    const browserTab = typeof v.browserTab === "number" && Number.isInteger(v.browserTab) ? v.browserTab : undefined;
    return { kind: "tab", ticketKey: v.ticketKey, tab: v.tab as TabDrag["tab"], ...(browserTab !== undefined ? { browserTab } : {}) };
  } catch {
    return null;
  }
}

/** What a drop carries: the DataTransfer's data, else the drag this window started. */
export function dragSourceOf(dt: DataTransfer | null): DragSource | null {
  const ticketKey = dt?.getData(TICKET_MIME);
  if (ticketKey) return { kind: "ticket", ticketKey };
  const tab = dt?.getData(TAB_MIME);
  const parsed = tab ? parseTabDrag(tab) : null;
  if (parsed) return parsed;
  const leafId = dt?.getData(PANE_MIME);
  if (leafId) return { kind: "pane", leafId };
  return active;
}

/** A compact chip (key + title, and a tab's name) as the drag image, instead of a ghost of the whole card, header or tab. */
function setChipImage(dt: DataTransfer, { chip: keyText, title, tab }: DragImage) {
  const el = document.createElement("div");
  el.className = "drag-chip";
  const key = document.createElement("span");
  key.className = "drag-chip-key";
  key.textContent = keyText;
  el.append(key);
  if (tab) {
    const name = document.createElement("span");
    name.className = "drag-chip-tab";
    name.textContent = tab;
    el.append(name);
  }
  const label = document.createElement("span");
  label.className = "drag-chip-title";
  label.textContent = title || "Untitled";
  el.append(label);
  document.body.appendChild(el);
  dt.setDragImage(el, 14, 14);
  // The image is captured during dragstart; the element can go right after.
  setTimeout(() => el.remove());
}

/** What the drag image shows: the key (a linked ticket's "MH-62 · MH-124"), the title, and a tab's name. */
export interface DragImage {
  chip: string;
  title: string;
  tab?: string;
}

/** The window's outer box on the screen, which a drag has to leave to pop out. */
const windowBox = () => ({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight });

/**
 * What a drag released at `at` outside the window opens there: the pane itself (a grip), else the
 * ticket or the torn-off tab, moving the pane that already shows it on board `boardScope`.
 */
export function dragOut(source: DragSource, boardScope: string, at: ScreenPoint): boolean {
  if (source.kind === "pane") return popOutToWindow(boardScope, source.leafId, at);
  const content: PaneContent = source.kind === "ticket" ? { kind: "ticket", ticketKey: source.ticketKey, tab: "spec" } : tabContent(source);
  return popOutContentToWindow(boardScope, content, at);
}

/**
 * Props that make an element a drag source for `source`: a ticket (a card or child row), a tab
 * (a tab button, browser chip or the composer's grip), or a pane (its header grip). `boardScope`
 * is the board this window shows (useBoardScope), where a drag released outside the window takes
 * what it carries from.
 */
export function dragProps(source: DragSource, image: DragImage, boardScope: string) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      const dt = e.dataTransfer;
      if (source.kind === "pane") dt.setData(PANE_MIME, source.leafId);
      else if (source.kind === "ticket") dt.setData(TICKET_MIME, source.ticketKey);
      else dt.setData(TAB_MIME, JSON.stringify({ ticketKey: source.ticketKey, tab: source.tab, ...(source.browserTab !== undefined ? { browserTab: source.browserTab } : {}) }));
      dt.setData("text/plain", source.kind === "pane" ? image.chip : source.ticketKey);
      dt.effectAllowed = "move";
      setChipImage(dt, image);
      // Next tick: Chromium can cancel a drag whose dragstart puts something under the pointer.
      const g = ++generation;
      setTimeout(() => g === generation && setActive(source));
    },
    onDragEnd: (e: DragEvent) => {
      endDrag();
      const at = dragOutPoint({ dropEffect: e.dataTransfer.dropEffect, screenX: e.screenX, screenY: e.screenY }, windowBox());
      if (at) dragOut(source, boardScope, at);
    },
  };
}

const SPLITS: { id: string; label: string; zone: DropZone }[] = [
  { id: "split-right", label: "Open to the Right", zone: "right" },
  { id: "split-below", label: "Open Below", zone: "bottom" },
  { id: "split-left", label: "Open to the Left", zone: "left" },
  { id: "split-above", label: "Open Above", zone: "top" },
];
const NEW_WINDOW = { id: "window", label: "Open in New Window" };

/**
 * Right-click (or the context-menu key on a focused card or row): Open, or open in a new split in
 * the `scope` workspace beside the pane `fromPaneId` (a child row's own pane), else the focused
 * pane, else the board, or in a window of its own. `discard` adds Discard draft (a draft's card).
 * The keyboard way to do what dragging does. Outside Electron the browser's own menu shows.
 */
export async function ticketContextMenu(e: MouseEvent, scope: string, ticketKey: string, open: () => void, fromPaneId: string | null = null, discard?: () => void, boardScope: string = scope) {
  const bridge = window.harness;
  if (!bridge?.showContextMenu) return;
  e.preventDefault();
  e.stopPropagation();
  // A pop-out holds one pane: nothing splits beside it.
  const splits = isPopoutScope(scope) ? [] : SPLITS;
  const choice = await bridge.showContextMenu([
    { id: "open", label: "Open" },
    { type: "separator" },
    ...splits.map(({ id, label }) => ({ id, label })),
    NEW_WINDOW,
    // A draft card: throw it away (the delete of a draft).
    ...(discard ? [{ type: "separator" as const }, { id: "discard", label: "Discard draft…" }] : []),
  ]);
  if (choice === "open") return open();
  if (choice === "discard") return discard?.();
  if (choice === NEW_WINDOW.id) return void popOutContentToWindow(boardScope, { kind: "ticket", ticketKey, tab: "spec" });
  const split = splits.find((s) => s.id === choice);
  if (split) dropOnBoard(scope, { kind: "ticket", ticketKey }, splitTarget(getPanes(scope), fromPaneId, ticketKey), split.zone);
}

/**
 * Right-click on a ticket's tab, a browser chip or the composer's grip: open it as a pane of its
 * own beside the pane it's in (`fromPaneId`, in `scope`), or in a window, or bring it back once
 * it's torn off (`torn`). The keyboard way to do what dragging the tab does.
 */
export async function tabContextMenu(e: MouseEvent, scope: string, boardScope: string, fromPaneId: string, tab: TabDrag, torn: TornOff | undefined) {
  const bridge = window.harness;
  if (!bridge?.showContextMenu) return;
  e.preventDefault();
  e.stopPropagation();
  const splits = isPopoutScope(scope) ? [] : SPLITS;
  const choice = await bridge.showContextMenu([
    ...splits.map(({ id, label }) => ({ id, label })),
    NEW_WINDOW,
    ...(torn ? [{ type: "separator" as const }, { id: "return", label: "Return to this window" }] : []),
  ]);
  if (choice === "return") return returnTabPane(boardScope, tab.ticketKey, tornId(tab));
  if (choice === NEW_WINDOW.id) return void popOutContentToWindow(boardScope, tabContent(tab));
  const split = splits.find((s) => s.id === choice);
  if (!split) return;
  const s = getPanes(scope);
  // Beside the pane the tab is in (a torn-off pane's own tab isn't a target for itself).
  const target = findLeaf(s.root, fromPaneId) ? fromPaneId : splitTarget(s);
  dropOnBoard(scope, tab, target, split.zone);
}
