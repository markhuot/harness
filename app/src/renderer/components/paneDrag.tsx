// Dragging tickets and panes onto the pane workspace. Sources (board cards, conductor child rows,
// a ticket pane's header grip) call `dragProps`; while one of them is being dragged, the workspace
// shows a drop layer over every pane (PaneWorkspace.tsx) that previews and applies the drop through
// the pure helpers in state/panes.ts (zoneAt, dropTargetAt, applyDrop).
//
// The dragged thing is in the DataTransfer under our own types, so the layer can ignore drags that
// aren't ours (files, text) from `types` alone during dragover, when the data itself is hidden.
// It's also kept here, since dragover needs to know what's dragged to decide whether a drop
// would do anything.

import { useSyncExternalStore, type DragEvent, type MouseEvent } from "react";
import { applyDrop, splitTarget, updatePanes, type DragSource, type DropZone } from "../state/panes";

export const TICKET_MIME = "application/x-harness-ticket";
export const PANE_MIME = "application/x-harness-pane";

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
export const isHarnessDrag = (dt: DataTransfer | null) => !!dt && (dt.types.includes(TICKET_MIME) || dt.types.includes(PANE_MIME));

/** What a drop carries: the DataTransfer's data, else the drag this window started. */
export function dragSourceOf(dt: DataTransfer | null): DragSource | null {
  const ticketKey = dt?.getData(TICKET_MIME);
  if (ticketKey) return { kind: "ticket", ticketKey };
  const leafId = dt?.getData(PANE_MIME);
  if (leafId) return { kind: "pane", leafId };
  return active;
}

/** A compact chip (key + title) as the drag image, instead of a ghost of the whole card or header. */
function setChipImage(dt: DataTransfer, ticketKey: string, title: string) {
  const chip = document.createElement("div");
  chip.className = "drag-chip";
  const key = document.createElement("span");
  key.className = "drag-chip-key";
  key.textContent = ticketKey;
  const label = document.createElement("span");
  label.className = "drag-chip-title";
  label.textContent = title || "Untitled";
  chip.append(key, label);
  document.body.appendChild(chip);
  dt.setDragImage(chip, 14, 14);
  // The image is captured during dragstart; the element can go right after.
  setTimeout(() => chip.remove());
}

/**
 * Props that make an element a drag source for a ticket (a card or child row) or, with `paneId`,
 * for the pane showing it (the header grip).
 */
export function dragProps(ticketKey: string, title: string, paneId?: string) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      const dt = e.dataTransfer;
      if (paneId) dt.setData(PANE_MIME, paneId);
      else dt.setData(TICKET_MIME, ticketKey);
      dt.setData("text/plain", ticketKey);
      dt.effectAllowed = "move";
      setChipImage(dt, ticketKey, title);
      // Next tick: Chromium can cancel a drag whose dragstart puts something under the pointer.
      const source: DragSource = paneId ? { kind: "pane", leafId: paneId } : { kind: "ticket", ticketKey };
      const g = ++generation;
      setTimeout(() => g === generation && setActive(source));
    },
    onDragEnd: endDrag,
  };
}

const SPLITS: { id: string; label: string; zone: DropZone }[] = [
  { id: "split-right", label: "Open to the Right", zone: "right" },
  { id: "split-below", label: "Open Below", zone: "bottom" },
  { id: "split-left", label: "Open to the Left", zone: "left" },
  { id: "split-above", label: "Open Above", zone: "top" },
];

/**
 * Right-click (or the context-menu key on a focused card or row): Open, or open in a new split
 * beside the pane `fromPaneId` (a child row's own pane), else the focused pane, else the board.
 * The keyboard way to do what dragging does. Outside Electron the browser's own menu shows.
 */
export async function ticketContextMenu(e: MouseEvent, ticketKey: string, open: () => void, fromPaneId: string | null = null) {
  const bridge = window.harness;
  if (!bridge?.showContextMenu) return;
  e.preventDefault();
  e.stopPropagation();
  const choice = await bridge.showContextMenu([{ id: "open", label: "Open" }, { type: "separator" }, ...SPLITS.map(({ id, label }) => ({ id, label }))]);
  if (choice === "open") return open();
  const split = SPLITS.find((s) => s.id === choice);
  if (split) updatePanes((s) => applyDrop(s, { kind: "ticket", ticketKey }, splitTarget(s, fromPaneId, ticketKey), split.zone));
}
