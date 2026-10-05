// Pinch-zoom of a browser tab's frame in the apps' panes (DESIGN.md "Browser"). The frame is drawn
// letterboxed (fitRect); zooming scales that drawn rect 1–BROWSER_ZOOM_MAX× around the pinch and
// panning moves it. Only the app's view changes: the page never sees the pinch. Input maps through
// the zoomed rect with toPagePoint, like the unzoomed one. HarnessKit's BrowserZoom.swift is the
// iOS port, held to these functions by shared/fixtures/cases/browserZoom.ts.

import type { Rect } from "./format";

export const BROWSER_ZOOM_MAX = 4;

/** Below this the frame snaps back to its fitted size, so a pinch out lands exactly on 1×. */
const SNAP = 1.01;

/** How far the drawn rect is zoomed from the fitted one (1 = not zoomed). */
export function zoomScale(fit: Rect, drawn: Rect): number {
  return fit.w > 0 ? drawn.w / fit.w : 1;
}

/**
 * Keep a zoomed rect covering the box: along an axis where it's wider (or taller) than the box, no
 * gap may show at either edge; where it isn't, it's centered, as the fitted frame is.
 */
export function clampZoomRect(box: { w: number; h: number }, fit: Rect, rect: Rect): Rect {
  if (!fit.w || !fit.h) return fit;
  if (zoomScale(fit, rect) < SNAP) return fit;
  const axis = (pos: number, size: number, room: number) => (size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, pos)));
  return { x: axis(rect.x, rect.w, box.w), y: axis(rect.y, rect.h, box.h), w: rect.w, h: rect.h };
}

/**
 * Zoom the drawn rect by `factor` (a pinch's scale change) around `anchor` (the pinch's center, in
 * box coordinates): the page point under the anchor stays under it. The zoom is held to
 * 1–BROWSER_ZOOM_MAX× of the fitted size.
 */
export function zoomRect(box: { w: number; h: number }, fit: Rect, drawn: Rect, factor: number, anchor: { x: number; y: number }): Rect {
  if (!fit.w || !fit.h || !drawn.w || !Number.isFinite(factor) || factor <= 0) return clampZoomRect(box, fit, drawn);
  const scale = Math.min(BROWSER_ZOOM_MAX, Math.max(1, zoomScale(fit, drawn) * factor));
  const w = fit.w * scale;
  const h = fit.h * scale;
  const ratio = w / drawn.w;
  const x = anchor.x - (anchor.x - drawn.x) * ratio;
  const y = anchor.y - (anchor.y - drawn.y) * ratio;
  return clampZoomRect(box, fit, { x, y, w, h });
}

/** Move a zoomed rect by (dx, dy), kept covering the box. At 1× nothing moves. */
export function panRect(box: { w: number; h: number }, fit: Rect, drawn: Rect, dx: number, dy: number): Rect {
  return clampZoomRect(box, fit, { x: drawn.x + dx, y: drawn.y + dy, w: drawn.w, h: drawn.h });
}
