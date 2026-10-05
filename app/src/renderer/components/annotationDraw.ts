// Drawing an annotation's marks (DESIGN.md "Annotations") over an image: in the annotator, over a
// thumbnail in an attachment row, and in the lightbox. The image itself is never drawn on; the
// marks are metadata on its attachment. The geometry comes from @harness/shared/state; only the
// canvas calls are here.

import { annotationStyle, arrowGeometry, badgeCenter, toSurface, type AnnotationStyle, type DraftMark, type Point } from "@harness/shared/state";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawOptions {
  /** Fill of the badges and arrows. */
  color: string;
  /** The mark whose message field has the focus: drawn with a halo (on screen only). */
  selected?: number | null;
  /** Sizes to draw with; default: annotationStyle for the surface (a thumbnail passes its own). */
  style?: AnnotationStyle;
}

const OUTLINE = "#fff";

/** The marks over a `width`×`height` surface whose top-left is the context's origin. */
export function drawAnnotations(ctx: Ctx, marks: readonly DraftMark[], width: number, height: number, opts: DrawOptions) {
  const style = opts.style ?? annotationStyle(width, height);
  const at = (p: Point) => toSurface(p, width, height);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Arrows first, so every badge sits on top of every line.
  for (const m of marks) {
    if (!m.tail) continue;
    const g = arrowGeometry(at(m.tail), at(m.anchor), style);
    if (!g) continue;
    for (const [stroke, extra] of [
      [OUTLINE, style.outline * 2],
      [opts.color, 0],
    ] as const) {
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = style.lineWidth + extra;
      ctx.beginPath();
      ctx.moveTo(g.line[0].x, g.line[0].y);
      ctx.lineTo(g.line[1].x, g.line[1].y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(g.head[0].x, g.head[0].y);
      ctx.lineTo(g.head[1].x, g.head[1].y);
      ctx.lineTo(g.head[2].x, g.head[2].y);
      ctx.closePath();
      if (extra) {
        ctx.lineWidth = extra;
        ctx.stroke();
      }
      ctx.fill();
    }
  }
  marks.forEach((m, i) => {
    const c = at(badgeCenter(m));
    if (opts.selected === i) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, style.badgeRadius + style.outline * 3.5, 0, Math.PI * 2);
      ctx.fillStyle = opts.color;
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(c.x, c.y, style.badgeRadius + style.outline, 0, Math.PI * 2);
    ctx.fillStyle = OUTLINE;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c.x, c.y, style.badgeRadius, 0, Math.PI * 2);
    ctx.fillStyle = opts.color;
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${style.fontSize}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Optical centre: digits sit a touch high on the middle baseline.
    ctx.fillText(String(i + 1), c.x, c.y + style.fontSize * 0.04);
  });
  ctx.restore();
}

/** The accent the app's theme uses right now, resolved to something a canvas takes. */
export function accentColor(): string {
  const probe = document.createElement("span");
  probe.style.color = "var(--accent)";
  probe.style.display = "none";
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c || "#2563eb";
}
