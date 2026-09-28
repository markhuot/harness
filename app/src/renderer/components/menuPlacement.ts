// Where a MenuButton popover goes (components/bits.tsx): under its trigger, lined up with the
// trigger's left or right edge, and kept inside the window. Pure so the edge cases are unit tested.

export interface MenuPlacement {
  left: number;
  top: number;
  /** Set when the menu is taller than the room on either side; it scrolls. */
  maxHeight: number | null;
  /** Opened above the trigger (there wasn't room below). */
  above: boolean;
}

/**
 * Place a `width` × `height` menu for a trigger at `anchor` in a `vw` × `vh` window. It opens
 * `gap` px below the trigger, aligned to its `align` edge (shifted `offsetX` px), then:
 *   • shifts left or right so it stays `margin` px inside the window's sides;
 *   • flips above the trigger when it doesn't fit below but does above;
 *   • when it fits neither way, takes the roomier side and caps its height there.
 */
export function placeMenu(opts: {
  anchor: { left: number; right: number; top: number; bottom: number };
  width: number;
  height: number;
  vw: number;
  vh: number;
  align: "left" | "right";
  gap?: number;
  offsetX?: number;
  margin?: number;
}): MenuPlacement {
  const { anchor, width, height, vw, vh, align, gap = 4, offsetX = 0, margin = 8 } = opts;
  let left = (align === "right" ? anchor.right - width : anchor.left) + offsetX;
  left = Math.max(margin, Math.min(left, vw - margin - width));
  const below = anchor.bottom + gap;
  const roomBelow = vh - margin - below;
  const roomAbove = anchor.top - gap - margin;
  if (height <= roomBelow) return { left, top: below, maxHeight: null, above: false };
  if (height <= roomAbove) return { left, top: anchor.top - gap - height, maxHeight: null, above: true };
  return roomBelow >= roomAbove
    ? { left, top: below, maxHeight: Math.max(0, roomBelow), above: false }
    : { left, top: margin, maxHeight: Math.max(0, roomAbove), above: true };
}
