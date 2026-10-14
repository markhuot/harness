import { describe, expect, test } from "bun:test";
import { MAX_HIGHLIGHT_LINES, clampRange, countLines, createBaseline, offsetOf, positionOf, selectionLines } from "./doc";

describe("clampRange", () => {
  test("pulls a range past the end of the file onto its last line", () => {
    expect(clampRange({ start: 40, end: 90 }, 5)).toEqual({ start: 5, end: 5 });
  });
  test("a missing or NaN end reveals just the start line", () => {
    expect(clampRange({ start: 3 } as never, 9)).toEqual({ start: 3, end: 3 });
    expect(clampRange({ start: 3, end: NaN }, 9)).toEqual({ start: 3, end: 3 });
  });
  test("an end before the start, or a start below 1, is pulled in", () => {
    expect(clampRange({ start: 0, end: -4 }, 9)).toEqual({ start: 1, end: 1 });
    expect(clampRange({ start: 6, end: 2 }, 9)).toEqual({ start: 6, end: 6 });
  });
  test("fractions round down", () => {
    expect(clampRange({ start: 2.9, end: 4.2 }, 9)).toEqual({ start: 2, end: 4 });
  });
});

describe("selectionLines", () => {
  const at = (line: number, character: number) => ({ line, character });
  test("a caret selects no lines", () => {
    expect(selectionLines({ start: at(3, 2), end: at(3, 2) })).toBeNull();
    expect(selectionLines(undefined)).toBeNull();
  });
  test("a selection inside one line is that line", () => {
    expect(selectionLines({ start: at(3, 1), end: at(3, 4) })).toEqual({ start: 4, end: 4 });
  });
  test("a selection across lines runs from the first to the last, 1-based", () => {
    expect(selectionLines({ start: at(0, 5), end: at(2, 0) })).toEqual({ start: 1, end: 3 });
  });
});

describe("countLines", () => {
  test("counts every kind of line break, a lone CR included, and a CRLF once", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a\nb\n")).toBe(3);
    expect(countLines("a\r\nb\r\nc")).toBe(3);
    expect(countLines("a\rb\nc\r\nd")).toBe(4);
  });
  test("the highlight cap is a line count the open path compares against", () => {
    expect(countLines("x\n".repeat(MAX_HIGHLIGHT_LINES))).toBeGreaterThan(MAX_HIGHLIGHT_LINES);
  });
});

describe("offsetOf and positionOf", () => {
  const text = "ab\r\ncd\nef\rgh";
  test("an offset counts a line break at its own length, and reads back as the same position", () => {
    for (const pos of [{ line: 0, character: 1 }, { line: 1, character: 2 }, { line: 2, character: 0 }, { line: 3, character: 2 }]) {
      expect(positionOf(text, offsetOf(text, pos))).toEqual(pos);
    }
    expect(offsetOf(text, { line: 1, character: 0 })).toBe(4);
    expect(offsetOf(text, { line: 3, character: 0 })).toBe(10);
  });
  test("a position past the end stops at the end of the text", () => {
    expect(offsetOf(text, { line: 9, character: 9 })).toBe(text.length);
    expect(positionOf(text, 999)).toEqual({ line: 3, character: 2 });
  });
});

describe("baseline", () => {
  test("opens clean, flips once on an edit and once back, and not on every keystroke", () => {
    const b = createBaseline("disk");
    expect(b.dirty).toBe(false);
    expect(b.check("disk!")).toBe(true);
    expect(b.check("disk!!")).toBe(false);
    expect(b.dirty).toBe(true);
    expect(b.check("disk")).toBe(true);
    expect(b.dirty).toBe(false);
  });
  test("typing after a save event stays dirty when the host confirms the old contents", () => {
    const b = createBaseline("v1");
    b.check("v2");
    expect(b.mark("v2", "v2 and more")).toBe(false);
    expect(b.dirty).toBe(true);
    expect(b.saved).toBe("v2");
    expect(b.check("v2")).toBe(true);
  });
  test("marking the current text clean flips the flag", () => {
    const b = createBaseline("v1");
    b.check("v2");
    expect(b.mark("v2", "v2")).toBe(true);
    expect(b.dirty).toBe(false);
  });
  test("an editor reopened with unsaved edits starts dirty, and typing back to disk is clean", () => {
    const b = createBaseline("disk", true);
    expect(b.dirty).toBe(true);
    expect(b.check("disk")).toBe(true);
    expect(b.dirty).toBe(false);
  });
});
