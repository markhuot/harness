// Pure layout math for summary attachments: thumbnail sizes in the Summaries tab, and paging
// and swipe-to-close in the full-screen viewer (ui/Attachments.tsx).

import type { SummaryAttachment } from "@harness/shared";

/** Thumbnail row height; widths follow each attachment's aspect ratio within these bounds. */
export const THUMB = { height: 120, minWidth: 72, maxWidth: 240 } as const;

/** Width / height, when both are known and positive; otherwise a default per kind (video 16:9, image 4:3). */
export function aspectOf(a: Pick<SummaryAttachment, "kind" | "width" | "height">): number {
  if (a.width && a.height && a.width > 0 && a.height > 0) return a.width / a.height;
  return a.kind === "video" ? 16 / 9 : 4 / 3;
}

/** The thumbnail's box: fixed height, width from the aspect ratio clamped so panoramas and tall shots stay tappable. */
export function thumbSize(a: Pick<SummaryAttachment, "kind" | "width" | "height">, t: { height: number; minWidth: number; maxWidth: number } = THUMB): { width: number; height: number } {
  const width = Math.round(Math.min(t.maxWidth, Math.max(t.minWidth, t.height * aspectOf(a))));
  return { width, height: t.height };
}

/**
 * The image's size once fitted inside `box` without upscaling past its own pixels (a small
 * screenshot stays crisp at 1:1 instead of blowing up). Unknown sizes fill the box.
 */
export function fitSize(a: Pick<SummaryAttachment, "kind" | "width" | "height">, box: { width: number; height: number }): { width: number; height: number } {
  if (box.width <= 0 || box.height <= 0) return { width: 0, height: 0 };
  const known = !!(a.width && a.height && a.width > 0 && a.height > 0);
  const ratio = aspectOf(a);
  let width = Math.min(box.width, box.height * ratio);
  if (known) width = Math.min(width, a.width!);
  return { width: Math.round(width), height: Math.round(width / ratio) };
}

/** A page index kept inside [0, count - 1] (0 when there are no pages). */
export function clampPage(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(index)));
}

/** The page a horizontal pager rests on at `offsetX`. */
export function pageAt(offsetX: number, pageWidth: number, count: number): number {
  return pageWidth > 0 ? clampPage(offsetX / pageWidth, count) : 0;
}

/** Swipe-down-to-close thresholds: a long drag, or a shorter one flicked downward. */
export const DISMISS = { distance: 120, flickDistance: 40, flickVelocity: 0.8 } as const;

/** Whether a vertical drag released at `dy` (points, down positive) and `vy` (points/ms) closes the viewer. */
export function shouldDismiss(dy: number, vy: number): boolean {
  return dy >= DISMISS.distance || (dy >= DISMISS.flickDistance && vy >= DISMISS.flickVelocity);
}

/** A zoomed page pans instead: its top-edge bounce isn't a pull. */
const isZoomed = (zoomScale: number) => zoomScale > 1.01;

/**
 * How far a viewer page is pulled down, from its scroll view's bounce: iOS reports a pull as a
 * negative content offset. Zero when zoomed or scrolled the other way.
 */
export function pullOf(offsetY: number, zoomScale = 1): number {
  return isZoomed(zoomScale) ? 0 : Math.max(0, -offsetY);
}

/**
 * Whether letting go of a page closes the viewer. `velocityY` is the scroll view's end-drag
 * velocity (points/ms, negative while pulling content down).
 */
export function dismissOnRelease(offsetY: number, velocityY: number, zoomScale = 1): boolean {
  return !isZoomed(zoomScale) && shouldDismiss(pullOf(offsetY), -velocityY);
}

/** "after.png · 1.2 MB" style sizes. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  const round = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  let v = bytes / 1024;
  let u = 0;
  // Promote on the rounded value, so 1023.96 KB reads "1 MB" rather than "1024 KB".
  while (round(v) >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${round(v)} ${units[u]}`;
}
