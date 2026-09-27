// A draggable pane edge (role=separator): pointer drag, arrow keys, double-click to reset.
// While dragging, a full-window overlay sits above everything so plugin iframes and the browser
// canvas can't swallow the pointer, and the width is previewed imperatively (no React render
// per pointermove); the final width is committed once on release.

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { dragWidth, keyWidth, type Bounds } from "../state/layout";
import "./panes.css";

export function ResizeHandle({
  edge,
  target,
  bounds,
  onPreview,
  onCommit,
  onReset,
  label,
  className = "",
  testId,
}: {
  /** Which edge of the pane the handle sits on */
  edge: "left" | "right";
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

  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add("is-resizing");
    return () => document.documentElement.classList.remove("is-resizing");
  }, [dragging]);

  const measured = () => Math.round(target.current?.getBoundingClientRect().width ?? width);

  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (commit && d?.last != null && d.last !== d.startWidth) onCommit(d.last);
  };

  return (
    <div
      className={`resize-handle resize-${edge} ${dragging ? "dragging" : ""} ${className}`}
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
        const w = dragWidth(d.startWidth, d.startX, e.clientX, edge, d.bounds);
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
        const w = keyWidth(e.key, e.shiftKey, measured(), edge, b);
        if (w === null) return;
        e.preventDefault();
        setRange(b);
        onPreview(w);
        onCommit(w);
      }}
    >
      {dragging && createPortal(<div className="resize-overlay" data-testid="resize-overlay" />, document.body)}
    </div>
  );
}
