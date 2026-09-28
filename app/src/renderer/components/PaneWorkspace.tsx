// The pane workspace: everything in <main> on the board route is a split tree of panes
// (state/panes.ts). The board is one pane and each open ticket another. Panes are rendered as flat,
// absolutely positioned siblings (layoutPanes), so reshaping the tree never remounts one: the board
// keeps its search and scroll, and a ticket keeps its transcript, browser and plugin frames.
//
// Dividers between split children resize with the pointer or the keyboard. While dragging, the
// new layout is written straight to the DOM (no React render per pointermove) and committed to
// the store once on release.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  closePane,
  findLeaf,
  focusPane,
  keySplit,
  layoutPanes,
  minSize,
  resizeSplit,
  setSizes,
  toggleZoom,
  updatePanes,
  usePanes,
  type DividerBox,
  type PaneLayout,
  type PaneLeaf,
  type PaneState,
  type Rect,
} from "../state/panes";
import { BoardPane } from "../views/Board";
import { TicketDetail } from "../views/TicketDetail";
import { useDragOverlay } from "./ResizeHandle";
import { PaneContext } from "./paneContext";
import "./panes.css";

const pct = (n: number) => `${n * 100}%`;
/** Half the divider's hit area; the visible line sits on the boundary between the panes. */
const DIVIDER_HALF = 3;

const leafStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });

function dividerStyle({ split, rect, at }: DividerBox): CSSProperties {
  return split.dir === "row"
    ? { left: `calc(${pct(at)} - ${DIVIDER_HALF}px)`, top: pct(rect.y), height: pct(rect.h), width: "" }
    : { top: `calc(${pct(at)} - ${DIVIDER_HALF}px)`, left: pct(rect.x), width: pct(rect.w), height: "" };
}

const dividerId = (d: DividerBox) => `${d.split.id}:${d.index}`;

/** Write a layout onto the rendered panes and dividers without going through React (drag preview). */
function applyLayout(root: HTMLElement, layout: PaneLayout) {
  for (const { leaf, rect } of layout.leaves) {
    const el = root.querySelector<HTMLElement>(`:scope > [data-pane-id="${CSS.escape(leaf.id)}"]`);
    if (el) Object.assign(el.style, leafStyle(rect));
  }
  for (const d of layout.dividers) {
    const el = root.querySelector<HTMLElement>(`:scope > [data-divider="${CSS.escape(dividerId(d))}"]`);
    if (el) Object.assign(el.style, dividerStyle(d));
  }
}

/** Escape ends a zoom, or else closes the focused ticket pane (never the board). */
function escapePanes(s: PaneState): PaneState {
  if (s.zoomedId) return toggleZoom(s, s.zoomedId);
  const leaf = s.focusedId ? findLeaf(s.root, s.focusedId) : null;
  return leaf?.content.kind === "ticket" ? closePane(s, leaf.id) : s;
}

export function PaneWorkspace({ onNewSession }: { onNewSession: () => void }) {
  const panes = usePanes();
  const layout = useMemo(() => layoutPanes(panes), [panes]);
  const ref = useRef<HTMLDivElement>(null);
  const multi = panes.root.type === "split";
  // DOM order by id, not tree order: existing panes never move in the DOM (moving an iframe
  // reloads it), new ones are simply added.
  const boxes = useMemo(() => [...layout.leaves].sort((a, b) => a.leaf.id.localeCompare(b.leaf.id, undefined, { numeric: true })), [layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Text fields and the browser canvas keep their Escape; an open modal or menu closes first.
      const el = e.target as HTMLElement;
      if (el.closest?.("input, textarea, select, [contenteditable=true], canvas") || document.querySelector(".modal, .menu")) return;
      updatePanes(escapePanes);
    };
    // A click inside a plugin iframe never reaches this document; the window blurs instead.
    const onBlur = () =>
      setTimeout(() => {
        const id = document.activeElement?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
        if (id) updatePanes((s) => focusPane(s, id));
      });
    addEventListener("keydown", onKey);
    addEventListener("blur", onBlur);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("blur", onBlur);
    };
  }, []);

  return (
    <div ref={ref} className={`pane-workspace ${multi ? "multi" : ""} ${panes.zoomedId ? "has-zoom" : ""}`} data-testid="pane-workspace">
      {boxes.map(({ leaf, rect, hidden }) => (
        <Pane
          key={leaf.id}
          leaf={leaf}
          rect={rect}
          hidden={hidden}
          focused={multi && leaf.id === panes.focusedId}
          corner={leaf.id === layout.cornerId}
          zoomed={leaf.id === panes.zoomedId}
          onNewSession={onNewSession}
        />
      ))}
      {layout.dividers.map((d) => (
        <Divider key={dividerId(d)} box={d} panes={panes} workspace={ref} />
      ))}
    </div>
  );
}

function Pane({
  leaf,
  rect,
  hidden,
  focused,
  corner,
  zoomed,
  onNewSession,
}: {
  leaf: PaneLeaf;
  rect: Rect;
  hidden: boolean;
  focused: boolean;
  corner: boolean;
  zoomed: boolean;
  onNewSession: () => void;
}) {
  const ctx = useMemo(() => ({ paneId: leaf.id }), [leaf.id]);
  const focus = () => updatePanes((s) => focusPane(s, leaf.id));
  const c = leaf.content;
  return (
    <section
      className={`pane pane-${c.kind} ${rect.y === 0 || zoomed ? "pane-top" : ""} ${focused ? "focused" : ""} ${corner ? "pane-corner" : ""} ${zoomed ? "zoomed" : ""} ${hidden ? "covered" : ""}`}
      data-pane-id={leaf.id}
      data-testid={`pane-${c.kind}`}
      style={leafStyle(rect)}
      aria-hidden={hidden || undefined}
      onPointerDownCapture={focus}
      // Tabbing into a pane focuses it (focus events alone would also fire for programmatic focus).
      onKeyUpCapture={(e) => e.key === "Tab" && focus()}
    >
      <PaneContext.Provider value={ctx}>
        {c.kind === "board" ? <BoardPane onNewSession={onNewSession} /> : <TicketDetail key={c.ticketKey} paneId={leaf.id} ticketKey={c.ticketKey} tab={c.tab} zoomed={zoomed} />}
      </PaneContext.Provider>
    </section>
  );
}

/** The draggable boundary between two children of a split (role=separator). */
function Divider({ box, panes, workspace }: { box: DividerBox; panes: PaneState; workspace: RefObject<HTMLDivElement | null> }) {
  const { split, index, rect } = box;
  const row = split.dir === "row";
  const [dragging, setDragging] = useState(false);
  const overlay = useDragOverlay(dragging ? (row ? "x" : "y") : null);
  const drag = useRef<{ start: number; total: number; mins: [number, number]; last: number[] | null } | null>(null);
  const panesRef = useRef(panes);
  panesRef.current = panes;

  /** The split's length along its axis, and the least each side of this divider may shrink to. */
  const measure = () => {
    const ws = workspace.current?.getBoundingClientRect();
    const total = ws ? (row ? rect.w * ws.width : rect.h * ws.height) : 0;
    const mins: [number, number] = [minSize(split.children[index]!, split.dir), minSize(split.children[index + 1]!, split.dir)];
    return { total, mins };
  };
  const preview = (sizes: number[] | null) => {
    const el = workspace.current;
    const s = panesRef.current;
    if (el) applyLayout(el, layoutPanes(sizes ? setSizes(s, split.id, sizes) : s));
  };
  const commit = (sizes: number[]) => updatePanes((s) => setSizes(s, split.id, sizes));
  const end = (keep: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (keep && d?.last) commit(d.last);
    else preview(null);
  };
  const share = split.sizes.slice(0, index + 1).reduce((a, b) => a + b, 0);

  return (
    <div
      className={`pane-divider pane-divider-${row ? "v" : "h"} ${dragging ? "dragging" : ""}`}
      data-divider={dividerId(box)}
      data-testid="pane-divider"
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label="Resize panes"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      title="Drag to resize (double-click to make them equal)"
      style={dividerStyle(box)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: row ? e.clientX : e.clientY, ...measure(), last: null };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = resizeSplit(split.sizes, index, (row ? e.clientX : e.clientY) - d.start, d.total, d.mins);
        preview(d.last);
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => drag.current && end(true)}
      onDoubleClick={() => commit(split.sizes.map(() => 1))}
      onKeyDown={(e) => {
        const { total, mins } = measure();
        const sizes = keySplit(e.key, e.shiftKey, split.dir, split.sizes, index, total, mins);
        if (!sizes) return;
        e.preventDefault();
        commit(sizes);
      }}
    >
      {overlay}
    </div>
  );
}
