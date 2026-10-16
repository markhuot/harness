import { describe, expect, test } from "bun:test";
import { cursorPos, firstCard, moveCursor, resolveCursor } from "../../../app/src/renderer/state/boardNav";

// Columns: [a b c] [] [d] [e f]
const grid = [["a", "b", "c"], [], ["d"], ["e", "f"]];

describe("cursorPos / firstCard", () => {
  test("finds a key, and null for none or missing", () => {
    expect(cursorPos(grid, "f")).toEqual({ col: 3, row: 1 });
    expect(cursorPos(grid, "zz")).toBeNull();
    expect(cursorPos(grid, null)).toBeNull();
  });
  test("firstCard skips empty leading columns; empty board is null", () => {
    expect(firstCard([[], ["x"]])).toBe("x");
    expect(firstCard([[], []])).toBeNull();
  });
});

describe("moveCursor", () => {
  test("no cursor or a vanished one lands on the first card", () => {
    expect(moveCursor(grid, null, "down")).toBe("a");
    expect(moveCursor(grid, "gone", "right")).toBe("a");
    expect(moveCursor([[]], null, "down")).toBeNull();
  });
  test("up and down stop at the column's ends", () => {
    expect(moveCursor(grid, "a", "up")).toBe("a");
    expect(moveCursor(grid, "c", "down")).toBe("c");
    expect(moveCursor(grid, "b", "down")).toBe("c");
    expect(moveCursor(grid, "b", "up")).toBe("a");
  });
  test("first and last go to the column's top and bottom", () => {
    expect(moveCursor(grid, "b", "first")).toBe("a");
    expect(moveCursor(grid, "b", "last")).toBe("c");
  });
  test("right skips empty columns and clamps the row", () => {
    expect(moveCursor(grid, "c", "right")).toBe("d");
    expect(moveCursor(grid, "d", "right")).toBe("e");
  });
  test("left skips empty columns and keeps the row when it fits", () => {
    expect(moveCursor(grid, "f", "left")).toBe("d");
    expect(moveCursor(grid, "d", "left")).toBe("a");
    expect(moveCursor([["a", "b"], ["c", "d"]], "d", "left")).toBe("b");
  });
  test("left and right stay put at the outermost non-empty column", () => {
    expect(moveCursor(grid, "a", "left")).toBe("a");
    expect(moveCursor(grid, "f", "right")).toBe("f");
    expect(moveCursor([["a"], []], "a", "right")).toBe("a");
  });
});

describe("resolveCursor", () => {
  test("null cursor stays null", () => {
    expect(resolveCursor(grid, null, { col: 0, row: 0 })).toBeNull();
  });
  test("a cursor still in its column stays, even when its row moved", () => {
    expect(resolveCursor(grid, "c", { col: 0, row: 0 })).toBe("c");
    expect(resolveCursor(grid, "a", null)).toBe("a");
  });
  test("a card that moved column falls back to the same row of its old column", () => {
    // 'b' was in col 0 row 1; now it sits in col 3
    const moved = [["a", "c"], [], ["d"], ["e", "b"]];
    expect(resolveCursor(moved, "b", { col: 0, row: 1 })).toBe("c");
  });
  test("a vanished card clamps the row and prefers the left column on a tie", () => {
    expect(resolveCursor([["a"], [], ["d", "x"]], "gone", { col: 1, row: 5 })).toBe("a");
    expect(resolveCursor([["a", "b"], ["c"]], "gone", { col: 0, row: 9 })).toBe("b");
  });
  test("a vanished card with no last position lands on the first card; empty board is null", () => {
    expect(resolveCursor(grid, "gone", null)).toBe("a");
    expect(resolveCursor([[], []], "gone", { col: 0, row: 0 })).toBeNull();
    expect(resolveCursor([[], []], "gone", null)).toBeNull();
  });
});
