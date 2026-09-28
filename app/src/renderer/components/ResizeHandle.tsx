// A draggable right edge for the sidebar (role=separator): pointer drag, arrow keys, double-click
// to reset. While dragging, a full-window overlay (useDragOverlay, shared with the pane dividers)
// sits above everything so plugin iframes and the browser canvas can't swallow the pointer, and the
// width is previewed imperatively (no React render per pointermove); the final width is committed
// once on release.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { dragWidth, keyWidth, type Bounds } from "../state/layout";
import "./panes.css";

/**
 * While `axis` is set (a drag is in progress): the resize cursor everywhere, no text selection, and
 * the returned portal covers the window so iframes and canvases can't take the pointer.
 */
export function useDragOverlay(axis: "x" | "y" | null): ReactNode {
  useEffect(() => {
    if (!axis) return;
    const root = document.documentElement.classList;
    const cls = axis === "x" ? "is-resizing" : "is-resizing-y";
    root.add(cls);
    return () => root.remove(cls);
  }, [axis]);
  return axis ? createPortal(<div className={`resize-overlay ${axis === "y" ? "resize-overlay-y" : ""}`} data-testid="resize-overlay" />, document.body) : null;
}

export function ResizeHandle({
  target,
  bounds,
  onPreview,
  onCommit,
  onReset,
  label,
  className = "",
  testId,
}: {
  /** The pane being resized (its rendered width is the starting point and aria-valuenow) */
  target: RefObject<HTMLElement | null>;
  bounds: () => Bounds;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
  onReset: () => void;
  label: string;
  className?: string;
  testId?: string;
}) {
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState<Bounds>(() => bounds());
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; bounds: Bounds; last: number | null } | null>(null);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(Math.round(el.getBoundingClientRect().width));
      setRange(bounds());
    });
    ro.observe(el);
    return () => ro.disconnect();
    // bounds() reads live DOM sizes, so its identity changing doesn't need a new observer.
  }, [target]);

  const overlay = useDragOverlay(dragging ? "x" : null);

  const measured = () => Math.round(target.current?.getBoundingClientRect().width ?? width);

  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (commit && d?.last != null && d.last !== d.startWidth) onCommit(d.last);
  };

  return (
    <div
      className={`resize-handle ${dragging ? "dragging" : ""} ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      tabIndex={0}
      data-testid={testId}
      title={`${label} (double-click to reset)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const b = bounds();
        setRange(b);
        drag.current = { startX: e.clientX, startWidth: measured(), bounds: b, last: null };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const w = dragWidth(d.startWidth, d.startX, e.clientX, d.bounds);
        if (w === d.last) return;
        d.last = w;
        onPreview(w);
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => drag.current && end(true)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const b = bounds();
        const w = keyWidth(e.key, e.shiftKey, measured(), b);
        if (w === null) return;
        e.preventDefault();
        setRange(b);
        onPreview(w);
        onCommit(w);
      }}
    >
      {overlay}
    </div>
  );
}
