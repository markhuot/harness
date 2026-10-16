import { describe, expect, test } from "bun:test";
import { ctrlChar, visibleHeight, viewportFor } from "./layout";

describe("viewportFor", () => {
  test("whole cells that fit, less the scrollbar", () => {
    expect(viewportFor(815, 400, { width: 8, height: 16 })).toEqual({ cols: 100, rows: 25 });
    expect(viewportFor(100, 100, { width: 8, height: 16 }, 0)).toEqual({ cols: 12, rows: 6 });
  });
  test("never less than one cell, and null when nothing can be measured", () => {
    expect(viewportFor(10, 5, { width: 8, height: 16 })).toEqual({ cols: 1, rows: 1 });
    expect(viewportFor(0, 100, { width: 8, height: 16 })).toBeNull();
    expect(viewportFor(100, 100, { width: 0, height: 16 })).toBeNull();
  });
});

describe("visibleHeight", () => {
  test("the keyboard takes its inset from the frame, never going below zero", () => {
    expect(visibleHeight(800, 0)).toBe(800);
    expect(visibleHeight(800, 300)).toBe(500);
    expect(visibleHeight(800, -5)).toBe(800);
    expect(visibleHeight(200, 300)).toBe(0);
  });
});

describe("ctrlChar", () => {
  test("letters and the usual punctuation make control characters", () => {
    expect(ctrlChar("c")).toBe("\x03");
    expect(ctrlChar("C")).toBe("\x03");
    expect(ctrlChar("[")).toBe("\x1b");
    expect(ctrlChar(" ")).toBe("\x00");
    expect(ctrlChar("?")).toBe("\x7f");
  });
  test("anything else passes through unchanged", () => {
    expect(ctrlChar("1")).toBeNull();
    expect(ctrlChar("ab")).toBeNull();
    expect(ctrlChar("\x1b[A")).toBeNull();
    expect(ctrlChar("")).toBeNull();
  });
});
