// Whether a drag that ended without a drop left the window: then whatever was dragged pops out into
// a window of its own under the pointer (components/paneDrag.tsx). Pure, so it's tested on its own.

export interface ScreenBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where to open a pop-out for a drag that ended (`dragend`), in screen coordinates; null when it
 * shouldn't. Only a drag nobody took (`dropEffect` "none") released outside `win` (the window's
 * outer bounds) pops out: a drop that landed somewhere did its own thing, and a drag cancelled
 * with Escape ends with the pointer still inside. A drag released over another app is outside
 * too, and our drags carry only our own types, which no other app takes, so it pops out as well.
 * Chromium reports (0, 0) when it doesn't know where the pointer was; that never pops out.
 */
export function dragOutPoint(end: { dropEffect: string; screenX: number; screenY: number }, win: ScreenBox): { x: number; y: number } | null {
  if (end.dropEffect !== "none") return null;
  const { screenX: x, screenY: y } = end;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;
  const inside = x >= win.x && x < win.x + win.width && y >= win.y && y < win.y + win.height;
  return inside ? null : { x: Math.round(x), y: Math.round(y) };
}
