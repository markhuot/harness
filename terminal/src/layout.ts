// Sizing arithmetic for a terminal view, with no DOM.

/** Width the scrollbar takes from the viewport (the same reservation ghostty-web's fit uses). */
export const SCROLLBAR_WIDTH = 15;

export interface CellSize {
  width: number;
  height: number;
}

/** How many columns and rows fit in `width` × `height` pixels, at least 1 each; null when unmeasurable. */
export function viewportFor(width: number, height: number, cell: CellSize, reserve = SCROLLBAR_WIDTH): { cols: number; rows: number } | null {
  if (!(cell.width > 0) || !(cell.height > 0) || !(width > 0) || !(height > 0)) return null;
  return {
    cols: Math.max(1, Math.floor((width - reserve) / cell.width)),
    rows: Math.max(1, Math.floor(height / cell.height)),
  };
}

/**
 * The height the terminal gets while the soft keyboard (and the key bar above it) covers `keyboardInset`
 * points of a web view `frameHeight` tall. The terminal shrinks to what's left, so its rows follow the
 * keyboard and the cursor row stays on screen.
 */
export function visibleHeight(frameHeight: number, keyboardInset: number): number {
  return Math.max(0, frameHeight - Math.max(0, keyboardInset));
}

/** The control character for a typed key (Ctrl+C → "\x03"), or null when Ctrl doesn't change it. */
export function ctrlChar(data: string): string | null {
  if (data.length !== 1) return null;
  const c = data.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // @ A-Z [ \ ] ^ _
  if (data === " ") return "\x00";
  if (data === "?") return "\x7f";
  return null;
}
