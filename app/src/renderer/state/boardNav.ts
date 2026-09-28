// The board's keyboard cursor, as pure grid math (tested in boardNav.test.ts). The grid is the
// ticket keys per column in board column order, exactly as rendered (empty columns
// included), and the cursor is a ticket key. Board.tsx keeps the cursor and moves DOM focus to it.

export type CursorDir = "left" | "right" | "up" | "down" | "first" | "last";

/** Where a card sits: its column and row in the grid. */
export interface CursorPos {
  col: number;
  row: number;
}

/** Where `key` is in the grid, or null when it isn't there. */
export function cursorPos(grid: string[][], key: string | null): CursorPos | null {
  if (key === null) return null;
  for (let col = 0; col < grid.length; col++) {
    const row = grid[col]!.indexOf(key);
    if (row >= 0) return { col, row };
  }
  return null;
}

/** The first card of the first non-empty column, or null on an empty board. */
export const firstCard = (grid: string[][]) => grid.find((c) => c.length)?.[0] ?? null;

/** The card at (col, row), with the row clamped to the column's last card. */
const cardAt = (grid: string[][], col: number, row: number) => {
  const c = grid[col]!;
  return c[Math.min(row, c.length - 1)]!;
};

/**
 * The cursor after one move. Up/down stay in the column and stop at its ends; left/right jump to
 * the nearest non-empty column that way, keeping the row where the column is long enough, and stay
 * put at the outermost one; first/last go to the column's top/bottom. No cursor (or one that's no
 * longer on the board) lands on the first card.
 */
export function moveCursor(grid: string[][], cursor: string | null, dir: CursorDir): string | null {
  const pos = cursorPos(grid, cursor);
  if (!pos) return firstCard(grid);
  const column = grid[pos.col]!;
  switch (dir) {
    case "up":
      return column[Math.max(0, pos.row - 1)]!;
    case "down":
      return column[Math.min(column.length - 1, pos.row + 1)]!;
    case "first":
      return column[0]!;
    case "last":
      return column[column.length - 1]!;
    case "left":
    case "right": {
      const step = dir === "left" ? -1 : 1;
      for (let col = pos.col + step; col >= 0 && col < grid.length; col += step) if (grid[col]!.length) return cardAt(grid, col, pos.row);
      return cursor;
    }
  }
}

/**
 * The cursor to show: `cursor` while its card is still in the column it was last seen in (`last`,
 * its last known position). When the card has gone (moved to another column, filtered out), the
 * card now nearest to where it was: the same row of that column, clamped, or else the nearest
 * non-empty column (the left one on a tie). Null with no cursor yet, or on an empty board.
 */
export function resolveCursor(grid: string[][], cursor: string | null, last: CursorPos | null): string | null {
  if (cursor === null) return null;
  const pos = cursorPos(grid, cursor);
  if (pos && (!last || pos.col === last.col)) return cursor;
  if (!last) return firstCard(grid);
  for (let d = 0; d < grid.length; d++) {
    for (const col of [last.col - d, last.col + d]) if (col >= 0 && col < grid.length && grid[col]!.length) return cardAt(grid, col, last.row);
  }
  return null;
}
