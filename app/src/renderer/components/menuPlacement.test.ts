import { describe, expect, test } from "bun:test";
import { placeMenu } from "./menuPlacement";

// A 28px trigger button near the top right of a 1280 × 800 window.
const btn = (left: number, top: number) => ({ left, right: left + 28, top, bottom: top + 28 });
const base = { width: 200, height: 150, vw: 1280, vh: 800 } as const;

describe("placeMenu", () => {
  test("opens below the trigger, lined up with the chosen edge, when it fits", () => {
    expect(placeMenu({ ...base, anchor: btn(600, 10), align: "right" })).toEqual({ left: 428, top: 42, maxHeight: null, above: false });
    expect(placeMenu({ ...base, anchor: btn(600, 10), align: "left" })).toEqual({ left: 600, top: 42, maxHeight: null, above: false });
  });

  test("a left-aligned menu near the right edge shifts left to stay inside the window", () => {
    // Would end at 1250 + 200 = 1450; the window's right margin is at 1272.
    expect(placeMenu({ ...base, anchor: btn(1250, 10), align: "left" }).left).toBe(1072);
    // A trigger past the window's edge (an overflowing titlebar) still gets a menu inside it.
    expect(placeMenu({ ...base, anchor: btn(1320, 10), align: "right" }).left).toBe(1072);
  });

  test("a right-aligned menu near the left edge shifts right", () => {
    expect(placeMenu({ ...base, anchor: btn(20, 10), align: "right" }).left).toBe(8);
  });

  test("the offset nudges the menu before clamping", () => {
    expect(placeMenu({ ...base, anchor: btn(600, 10), align: "right", offsetX: 5, gap: 8 })).toMatchObject({ left: 433, top: 46 });
  });

  test("flips above the trigger near the bottom of the window", () => {
    expect(placeMenu({ ...base, anchor: btn(600, 700), align: "right" })).toEqual({ left: 428, top: 546, maxHeight: null, above: true });
    // Exactly fitting below doesn't flip: 42 + 150 = 192 with the margin at 792.
    expect(placeMenu({ ...base, height: 750, anchor: btn(600, 10), align: "right" })).toMatchObject({ top: 42, maxHeight: null });
  });

  test("too tall for either side: the roomier side, with a capped height", () => {
    expect(placeMenu({ ...base, height: 900, anchor: btn(600, 100), align: "right" })).toEqual({ left: 428, top: 132, maxHeight: 660, above: false });
    expect(placeMenu({ ...base, height: 900, anchor: btn(600, 600), align: "right" })).toEqual({ left: 428, top: 8, maxHeight: 588, above: true });
  });

  test("a menu wider than the window starts at the left margin", () => {
    expect(placeMenu({ ...base, width: 1400, anchor: btn(600, 10), align: "right" }).left).toBe(8);
  });
});
