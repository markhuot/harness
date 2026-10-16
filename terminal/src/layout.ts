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
 * How far to lift the terminal so the cursor row stays visible above the soft keyboard. The
 * keyboard never changes the rows the terminal reports; the page just pans. `cursorBottom` is the
 * cursor row's bottom edge in the stage, `stageTop` the stage's offset in the viewport and
 * `viewportHeight` the web view's full height.
 */
export function keyboardPan(cursorBottom: number, stageTop: number, viewportHeight: number, keyboardInset: number): number {
  if (keyboardInset <= 0) return 0;
  const visibleBottom = viewportHeight - keyboardInset;
  return Math.max(0, stageTop + cursorBottom - visibleBottom);
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
