import { describe, expect, test } from "bun:test";
import { cursorPos, moveCursor, resolveCursor } from "./boardNav";

// Columns: planning [A1 A2 A3], in progress [], blocked [C1], review [], done [E1 E2].
const grid = [["A1", "A2", "A3"], [], ["C1"], [], ["E1", "E2"]];

describe("cursorPos", () => {
  test("finds a card's column and row", () => {
    expect(cursorPos(grid, "E2")).toEqual({ col: 4, row: 1 });
  });

  test("is null for a missing card or no cursor", () => {
    expect(cursorPos(grid, "Z9")).toBeNull();
    expect(cursorPos(grid, null)).toBeNull();
  });
});

describe("moveCursor", () => {
  test("up and down stay in the column and clamp at its ends", () => {
    expect(moveCursor(grid, "A2", "down")).toBe("A3");
    expect(moveCursor(grid, "A3", "down")).toBe("A3");
    expect(moveCursor(grid, "A2", "up")).toBe("A1");
    expect(moveCursor(grid, "A1", "up")).toBe("A1");
  });

  test("first and last go to the top and bottom of the cursor's column", () => {
    expect(moveCursor(grid, "A2", "first")).toBe("A1");
    expect(moveCursor(grid, "A1", "last")).toBe("A3");
    expect(moveCursor(grid, "E1", "last")).toBe("E2");
  });

  test("left and right skip empty columns", () => {
    expect(moveCursor(grid, "A1", "right")).toBe("C1");
    expect(moveCursor(grid, "C1", "right")).toBe("E1");
    expect(moveCursor(grid, "E1", "left")).toBe("C1");
    expect(moveCursor(grid, "C1", "left")).toBe("A1");
  });

  test("left and right keep the row, clamped to the column's last card", () => {
    expect(moveCursor(grid, "A3", "right")).toBe("C1");
    expect(moveCursor(grid, "E2", "left")).toBe("C1");
    expect(moveCursor([["A1", "A2", "A3"], ["B1", "B2", "B3"]], "A2", "right")).toBe("B2");
    expect(moveCursor([["A1", "A2", "A3"], ["B1", "B2"]], "A3", "right")).toBe("B2");
  });

  test("the outermost non-empty column is an edge, even with empty columns past it", () => {
    expect(moveCursor(grid, "A2", "left")).toBe("A2");
    expect(moveCursor(grid, "E2", "right")).toBe("E2");
    expect(moveCursor([[], ["B1"], []], "B1", "right")).toBe("B1");
    expect(moveCursor([[], ["B1"], []], "B1", "left")).toBe("B1");
  });

  test("no cursor lands on the first card of the first non-empty column", () => {
    expect(moveCursor(grid, null, "down")).toBe("A1");
    expect(moveCursor([[], [], ["C1", "C2"]], null, "right")).toBe("C1");
  });

  test("a cursor that isn't on the board lands on the first card", () => {
    expect(moveCursor([[], ["B1"]], "gone", "up")).toBe("B1");
  });

  test("an empty board has no cursor", () => {
    expect(moveCursor([[], [], []], null, "down")).toBeNull();
    expect(moveCursor([[], []], "A1", "left")).toBeNull();
    expect(moveCursor([], null, "first")).toBeNull();
  });
});

describe("resolveCursor", () => {
  test("keeps a cursor that's still in its column, following it up or down", () => {
    expect(resolveCursor(grid, "A3", { col: 0, row: 0 })).toBe("A3");
    expect(resolveCursor(grid, "C1", null)).toBe("C1");
  });

  test("a card that moved to another column leaves the cursor where it was", () => {
    // A2 went from planning to blocked: the cursor stays in planning, on A3 (now in A2's row).
    expect(resolveCursor([["A1", "A3"], [], ["A2", "C1"]], "A2", { col: 0, row: 1 })).toBe("A3");
  });

  test("no cursor stays none (the first card is the fallback focus target)", () => {
    expect(resolveCursor(grid, null, null)).toBeNull();
  });

  test("a vanished card falls back to the same spot in its column, clamped", () => {
    // A2 was filtered out: A3 slid up into its row.
    expect(resolveCursor([["A1", "A3"], []], "A2", { col: 0, row: 1 })).toBe("A3");
    // The column's last card left: the one above it.
    expect(resolveCursor([["A1", "A2"], []], "A3", { col: 0, row: 2 })).toBe("A2");
  });

  test("an emptied column falls back to the nearest non-empty one, keeping the row", () => {
    expect(resolveCursor([["A1"], [], [], ["D1", "D2"], ["E1"]], "B1", { col: 1, row: 1 })).toBe("A1");
    expect(resolveCursor([[], [], [], ["D1", "D2"], ["E1"]], "B2", { col: 1, row: 1 })).toBe("D2");
    expect(resolveCursor([["A1"], [], ["C1", "C2"]], "B2", { col: 1, row: 1 })).toBe("A1");
  });

  test("a vanished card with no known position lands on the first card", () => {
    expect(resolveCursor(grid, "Z9", null)).toBe("A1");
  });

  test("an empty board clears the cursor", () => {
    expect(resolveCursor([[], [], []], "A1", { col: 0, row: 0 })).toBeNull();
  });
});
