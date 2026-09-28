import { describe, expect, test } from "bun:test";
import { rovingIndex, tabStopIndex } from "./useRovingList";

describe("rovingIndex", () => {
  test("next and prev step by one and stop at the ends", () => {
    expect(rovingIndex(3, 0, "next")).toBe(1);
    expect(rovingIndex(3, 2, "next")).toBe(2);
    expect(rovingIndex(3, 1, "prev")).toBe(0);
    expect(rovingIndex(3, 0, "prev")).toBe(0);
  });

  test("wrap goes around the ends instead (menus)", () => {
    expect(rovingIndex(3, 2, "next", true)).toBe(0);
    expect(rovingIndex(3, 0, "prev", true)).toBe(2);
    expect(rovingIndex(3, 1, "next", true)).toBe(2);
  });

  test("first and last ignore where the focus is", () => {
    expect(rovingIndex(4, 2, "first")).toBe(0);
    expect(rovingIndex(4, -1, "last")).toBe(3);
  });

  test("with no item focused (or one that's gone), next starts at the top and prev at the bottom", () => {
    expect(rovingIndex(4, -1, "next")).toBe(0);
    expect(rovingIndex(4, -1, "prev")).toBe(3);
    // The focused item was removed and the list shrank under it.
    expect(rovingIndex(2, 5, "next")).toBe(0);
  });

  test("an empty list has nowhere to go", () => {
    for (const m of ["next", "prev", "first", "last"] as const) expect(rovingIndex(0, -1, m)).toBe(-1);
    expect(rovingIndex(1, 0, "next", true)).toBe(0);
  });
});

describe("tabStopIndex", () => {
  const items = (remembered: number, marked: number, n = 4) => Array.from({ length: n }, (_, i) => ({ remembered: i === remembered, marked: i === marked }));

  test("the first item when nothing is remembered or marked", () => {
    expect(tabStopIndex(items(-1, -1), false)).toBe(0);
  });

  test("the marked item on first render", () => {
    expect(tabStopIndex(items(-1, 2), false)).toBe(2);
  });

  test("the remembered item while the focus is in the list, even with another marked", () => {
    expect(tabStopIndex(items(1, 3), true)).toBe(1);
  });

  test("the marked item takes over once the focus has left", () => {
    expect(tabStopIndex(items(1, 3), false)).toBe(3);
  });

  test("the remembered item when nothing is marked (a list without a current item)", () => {
    expect(tabStopIndex(items(2, -1), false)).toBe(2);
  });

  test("no stop in an empty list", () => {
    expect(tabStopIndex([], false)).toBe(-1);
  });
});
