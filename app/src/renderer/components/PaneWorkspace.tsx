// The pane workspace: everything in <main> on the board route is a split tree of panes
// (state/panes.ts). The board is one pane, and each open ticket, terminal, file or New session another. Panes are rendered as flat,
// absolutely positioned siblings (layoutPanes), so reshaping the tree never remounts one: the board
// keeps its search and scroll, and a ticket keeps its transcript, browser and plugin frames.
//
// Dividers between split children resize with the pointer or the keyboard: every pane on each side
// of the divider scales together, or with ⌥ held only the two touching it. While dragging, the
// new layout is written straight to the DOM (no React render per pointermove) and committed to
// the store once on release.
//
// While a ticket or pane is being dragged (paneDrag.tsx), a drop layer covers the workspace, above
// plugin iframes and the browser canvas that would otherwise swallow the drag. The half of the pane
// under the pointer picks the drop (zoneAt); the preview shows where the dropped pane would land
// (dropPreview), and drop applies it.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type RefObject } from "react";
import {
  applyDrop,
  boardLeaf,
  dropPreview,
  dropTargetAt,
  fileKey,
  focusPane,
  keySplit,
  layoutPanes,
  minSize,
  resizeSplit,
  setSizes,
  updatePanes,
  usePanes,
  type DividerBox,
  type PaneArea,
  type DropZone,
  type PaneLayout,
  type PaneLeaf,
  type PaneState,
  type Rect,
} from "../state/panes";
import { ticketByKey } from "@harness/shared/state";
import { useStore } from "../state/store";
import { draftEditorKey } from "../state/draftSession";
import { BoardPane } from "../views/Board";
import { TicketDetail } from "../views/TicketDetail";
import { TerminalPane } from "../views/TerminalPane";
import { DraftEditor } from "../views/DraftEditor";
import { FilePane } from "../views/FilePane";
import { useDragOverlay } from "./ResizeHandle";
import { PaneContext, PaneScopeContext, usePaneScope } from "./paneContext";
import { dragSourceOf, endDrag, isHarnessDrag, useActiveDrag } from "./paneDrag";
import { focusPaneDom, rememberPaneFocus, takePaneFocusRequest } from "./paneFocus";
import { userInputWithin } from "../state/inputModality";
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

/**
 * The panes of one board scope (a project, or all projects). Switching scope swaps the whole tree:
 * the other scope's panes unmount, and its leaves (keyed by their ids, unique across scopes) mount
 * again when you come back.
 */
export function PaneWorkspace({ scope }: { scope: string }) {
  const panes = usePanes(scope);
  const ref = useRef<HTMLDivElement>(null);
  // The workspace's size, so stored sizes are clamped to the panes' minimums (layoutPanes).
  const [area, setArea] = useState<PaneArea | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setArea((a) => (a && a.width === el.clientWidth && a.height === el.clientHeight ? a : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = useMemo(() => layoutPanes(panes, area ?? undefined), [panes, area]);
  const multi = panes.root.type === "split";
  // The pane the keyboard acts on: the focused one, or the board before anything was focused.
  const activeId = panes.focusedId ?? boardLeaf(panes.root)?.id;
  // DOM order by id, not tree order: existing panes never move in the DOM (moving an iframe
  // reloads it), new ones are simply added.
  const boxes = useMemo(() => [...layout.leaves].sort((a, b) => a.leaf.id.localeCompare(b.leaf.id, undefined, { numeric: true })), [layout]);

  // A keyboard command moved the focused pane (components/paneFocus.ts): move DOM focus into it.
  useLayoutEffect(() => {
    if (takePaneFocusRequest() && panes.focusedId) focusPaneDom(panes.focusedId);
  }, [panes]);

  useEffect(() => {
    // Keys (Escape and the rest) are handled by the app's dispatcher (components/commands.tsx).
    // A click inside a plugin iframe never reaches this document; the window blurs instead.
    const onBlur = () =>
      setTimeout(() => {
        const id = document.activeElement?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
        if (id) updatePanes(scope, (s) => focusPane(s, id));
      });
    addEventListener("blur", onBlur);
    return () => removeEventListener("blur", onBlur);
  }, [scope]);

  return (
    <PaneScopeContext.Provider value={scope}>
    <div ref={ref} className={`pane-workspace ${multi ? "multi" : ""} ${panes.zoomedId ? "has-zoom" : ""}`} data-testid="pane-workspace">
      {boxes.map(({ leaf, rect, hidden }) => (
        <Pane
          key={leaf.id}
          leaf={leaf}
          rect={rect}
          hidden={hidden}
          focused={multi && leaf.id === panes.focusedId}
          active={leaf.id === activeId}
          corner={leaf.id === layout.cornerId}
          zoomed={leaf.id === panes.zoomedId}
        />
      ))}
      {layout.dividers.map((d) => (
        <Divider key={dividerId(d)} box={d} panes={panes} area={area} workspace={ref} />
      ))}
      <DropLayer layout={layout} panes={panes} area={area} workspace={ref} />
    </div>
    </PaneScopeContext.Provider>
  );
}

/** One pane: a leaf's content in its box. Also the whole of a pop-out window (components/PopoutWindow.tsx). */
export function Pane({
  leaf,
  rect,
  hidden,
  focused,
  corner,
  zoomed,
  active,
}: {
  leaf: PaneLeaf;
  rect: Rect;
  hidden: boolean;
  /** Drawn as the focused pane (only when there's more than one). */
  focused: boolean;
  /** The store's focused pane, drawn or not (a terminal takes the keyboard when it becomes this). */
  active: boolean;
  corner: boolean;
  zoomed: boolean;
}) {
  const ctx = useMemo(() => ({ paneId: leaf.id }), [leaf.id]);
  const scope = usePaneScope();
  const focus = () => updatePanes(scope, (s) => focusPane(s, leaf.id));
  const c = leaf.content;
  // A draft's pane is its editor, rendered here (not inside TicketDetail) under the same key as the
  // New session it started as: the first save swaps the content to the ticket without remounting
  // the editor, so the prompt keeps the keyboard and what's typed after it.
  const { state } = useStore();
  const draft = c.kind === "ticket" ? ticketByKey(state, c.ticketKey) : undefined;
  const shownDraft = useRef<string | null>(null);
  const wasDraft = !!draft && shownDraft.current === draft.id;
  shownDraft.current = draft?.draft ? draft.id : null;
  return (
    <section
      className={`pane pane-${c.kind} ${rect.y === 0 || zoomed ? "pane-top" : ""} ${focused ? "focused" : ""} ${active ? "active" : ""} ${corner ? "pane-corner" : ""} ${zoomed ? "zoomed" : ""} ${hidden ? "covered" : ""}`}
      data-pane-id={leaf.id}
      data-testid={`pane-${c.kind}`}
      style={leafStyle(rect)}
      aria-hidden={hidden || undefined}
      // The pane itself takes focus when a keyboard move lands on it with nothing inside to focus.
      tabIndex={-1}
      onPointerDownCapture={focus}
      onFocusCapture={(e) => {
        rememberPaneFocus(leaf.id, e.target as HTMLElement);
        // Focus the user moved here (Tab, a click) makes this the focused pane; focus moved by
        // code with no input nearby (an autofocus, a ticket asking for an answer) doesn't.
        if (userInputWithin(300)) focus();
      }}
    >
      <PaneContext.Provider value={ctx}>
        {c.kind === "board" ? (
          <BoardPane />
        ) : c.kind === "ticket" && draft?.draft ? (
          <DraftEditor key={draftEditorKey(leaf.id, draft.id)} paneId={leaf.id} ticket={draft} zoomed={zoomed} />
        ) : c.kind === "ticket" ? (
          <TicketDetail key={c.ticketKey} paneId={leaf.id} ticketKey={c.ticketKey} tab={c.tab} zoomed={zoomed} tabChosen={wasDraft} />
        ) : c.kind === "compose" ? (
          <DraftEditor key={`draft:${c.id}`} paneId={leaf.id} compose={c} zoomed={zoomed} />
        ) : c.kind === "file" ? (
          // Keyed by the file: a link that swaps the file in this pane starts from a clean slate
          // (no old contents or diff under the new header, a fresh scroll to its range).
          <FilePane key={fileKey(c)} paneId={leaf.id} content={c} zoomed={zoomed} />
        ) : (
          <TerminalPane key={c.sessionId} paneId={leaf.id} content={c} zoomed={zoomed} focused={active} />
        )}
      </PaneContext.Provider>
    </section>
  );
}

/** The draggable boundary between two children of a split (role=separator). */
function Divider({ box, panes, area, workspace }: { box: DividerBox; panes: PaneState; area: PaneArea | null; workspace: RefObject<HTMLDivElement | null> }) {
  // `sizes` is the split as rendered (clamped to minimums), so a drag or key starts from what's on screen.
  const { split, index, rect, sizes: shown } = box;
  const row = split.dir === "row";
  const [dragging, setDragging] = useState(false);
  const overlay = useDragOverlay(dragging ? (row ? "x" : "y") : null);
  const drag = useRef<{ start: number; at: number; total: number; mins: number[]; last: number[] | null } | null>(null);
  const panesRef = useRef(panes);
  panesRef.current = panes;

  /** The split's length along its axis, and the least each of its children may shrink to. */
  const measure = () => {
    const ws = workspace.current?.getBoundingClientRect();
    const total = ws ? (row ? rect.w * ws.width : rect.h * ws.height) : 0;
    const mins = split.children.map((c) => minSize(c, split.dir));
    return { total, mins };
  };
  const preview = (sizes: number[] | null) => {
    const el = workspace.current;
    const s = panesRef.current;
    if (el) applyLayout(el, layoutPanes(sizes ? setSizes(s, split.id, sizes) : s, area ?? undefined));
  };
  const scope = usePaneScope();
  const commit = (sizes: number[]) => updatePanes(scope, (s) => setSizes(s, split.id, sizes));
  const end = (keep: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (keep && d?.last) commit(d.last);
    else preview(null);
  };
  const share = shown.slice(0, index + 1).reduce((a, b) => a + b, 0);
  /** Preview the drag with the pointer at `at`: every pane on each side scales, or with ⌥ (`pair`) just the two touching the divider. */
  const follow = (at: number, pair: boolean) => {
    const d = drag.current;
    if (!d) return;
    d.at = at;
    d.last = resizeSplit(shown, index, at - d.start, d.total, d.mins, pair);
    preview(d.last);
  };
  // Pressing or releasing ⌥ mid-drag switches modes without waiting for the pointer to move.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Alt" && drag.current) follow(drag.current.at, e.altKey);
    };
    addEventListener("keydown", onKey);
    addEventListener("keyup", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKey);
    };
  });

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
      title="Drag to resize (⌥-drag to resize only these two, double-click to make them equal)"
      style={dividerStyle(box)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const start = row ? e.clientX : e.clientY;
        drag.current = { start, at: start, ...measure(), last: null };
        setDragging(true);
      }}
      onPointerMove={(e) => follow(row ? e.clientX : e.clientY, e.altKey)}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => drag.current && end(true)}
      onDoubleClick={() => commit(split.sizes.map(() => 1))}
      onKeyDown={(e) => {
        const { total, mins } = measure();
        const sizes = keySplit(e.key, e.shiftKey, split.dir, shown, index, total, mins, e.altKey);
        if (!sizes) return;
        e.preventDefault();
        commit(sizes);
      }}
    >
      {overlay}
    </div>
  );
}

type DropHit = { leafId: string; zone: DropZone; landing: Rect };

/**
 * Covers the workspace while a harness drag is in progress. dragover finds the pane and half under
 * the pointer and previews where the dropped pane would land, unless the drop would change nothing
 * (a pane over itself); drop applies it. Drags that aren't ours (files, text) pass through untouched.
 */
function DropLayer({ layout, panes, area, workspace }: { layout: PaneLayout; panes: PaneState; area: PaneArea | null; workspace: RefObject<HTMLDivElement | null> }) {
  const source = useActiveDrag();
  const scope = usePaneScope();
  const [hit, setHit] = useState<DropHit | null>(null);
  useEffect(() => {
    if (!source) setHit(null);
  }, [source]);
  if (!source) return null;

  /** The drop the pointer is over, or null where dropping does nothing. */
  const targetAt = (e: DragEvent): DropHit | null => {
    const ws = workspace.current?.getBoundingClientRect();
    if (!ws || !ws.width || !ws.height) return null;
    const t = dropTargetAt(layout, (e.clientX - ws.left) / ws.width, (e.clientY - ws.top) / ws.height);
    const landing = t && dropPreview(panes, source, t.leafId, t.zone, area ?? undefined);
    return t && landing ? { leafId: t.leafId, zone: t.zone, landing } : null;
  };
  const over = (e: DragEvent) => {
    if (!isHarnessDrag(e.dataTransfer)) return;
    const t = targetAt(e);
    if (t) {
      e.preventDefault(); // accept the drop here
      e.dataTransfer.dropEffect = "move";
    }
    setHit((h) => (h?.leafId === t?.leafId && h?.zone === t?.zone ? h : t));
  };

  return (
    <div
      className="pane-drop-layer"
      data-testid="pane-drop-layer"
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={() => setHit(null)}
      onDrop={(e) => {
        e.preventDefault();
        const t = targetAt(e);
        const src = dragSourceOf(e.dataTransfer);
        setHit(null);
        endDrag();
        if (t && src) updatePanes(scope, (s) => applyDrop(s, src, t.leafId, t.zone));
      }}
    >
      {hit && <div className="pane-drop-preview" data-testid="pane-drop-preview" data-zone={hit.zone} data-target={hit.leafId} style={leafStyle(hit.landing)} />}
    </div>
  );
}
