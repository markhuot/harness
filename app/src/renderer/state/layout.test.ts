import { describe, expect, test } from "bun:test";
import { BOARD_MIN, clampWidth, DEFAULT_LAYOUT, detailBounds, DETAIL_MIN, dragWidth, keyWidth, parseLayout, serializeLayout, SIDEBAR_MAX, SIDEBAR_MIN, sidebarBounds } from "./layout";

describe("clampWidth", () => {
  const b = { min: 200, max: 400 };
  test("keeps widths inside the bounds and rounds", () => {
    expect(clampWidth(300.6, b)).toBe(301);
    expect(clampWidth(199, b)).toBe(200);
    expect(clampWidth(401, b)).toBe(400);
  });
  test("the minimum wins when there is less room than the minimum", () => {
    expect(clampWidth(500, { min: 360, max: 300 })).toBe(360);
    expect(clampWidth(100, { min: 360, max: 300 })).toBe(360);
  });
});

describe("detailBounds", () => {
  test("caps at 80% of a wide window", () => {
    // Sidebar collapsed: layout = window = 2000; 80% = 1600 < 2000 - 320.
    expect(detailBounds(2000, 2000)).toEqual({ min: DETAIL_MIN, max: 1600 });
  });
  test("leaves the board BOARD_MIN when the sidebar takes the room", () => {
    // 1000px window: 80% = 800, but the layout is 768 → at most 768 - 320 = 448.
    expect(detailBounds(1000, 768)).toEqual({ min: DETAIL_MIN, max: 768 - BOARD_MIN });
  });
  test("never reports a max below the min on a cramped window", () => {
    expect(detailBounds(600, 400).max).toBe(DETAIL_MIN);
  });
});

describe("dragWidth", () => {
  const b = { min: 100, max: 500 };
  test("a right-edge handle grows when dragged right", () => {
    expect(dragWidth(250, 250, 300, "right", b)).toBe(300);
  });
  test("a left-edge handle grows when dragged left", () => {
    expect(dragWidth(400, 800, 700, "left", b)).toBe(500);
    expect(dragWidth(400, 800, 850, "left", b)).toBe(350);
  });
  test("stops at the bounds", () => {
    expect(dragWidth(400, 800, 0, "left", b)).toBe(500);
    expect(dragWidth(250, 250, -1000, "right", b)).toBe(100);
  });
});

describe("keyWidth", () => {
  const b = { min: 200, max: 600 };
  test("arrows move the handle in their direction", () => {
    expect(keyWidth("ArrowRight", false, 300, "right", b)).toBe(316);
    expect(keyWidth("ArrowLeft", false, 300, "right", b)).toBe(284);
    // The ticket panel's handle is on its left edge: moving it left widens the panel.
    expect(keyWidth("ArrowLeft", false, 300, "left", b)).toBe(316);
    expect(keyWidth("ArrowRight", true, 300, "left", b)).toBe(236);
  });
  test("Home/End jump to the bounds and arrows clamp", () => {
    expect(keyWidth("Home", false, 300, "left", b)).toBe(200);
    expect(keyWidth("End", false, 300, "left", b)).toBe(600);
    expect(keyWidth("ArrowRight", true, 590, "right", b)).toBe(600);
  });
  test("other keys aren't resize keys", () => {
    expect(keyWidth("Enter", false, 300, "right", b)).toBeNull();
    expect(keyWidth("ArrowUp", false, 300, "right", b)).toBeNull();
  });
});

describe("parseLayout", () => {
  test("round-trips", () => {
    const l = { sidebarCollapsed: true, sidebarWidth: 300, detailWidth: 720 };
    expect(parseLayout(serializeLayout(l))).toEqual(l);
  });
  test("missing or corrupt storage falls back to the defaults", () => {
    for (const raw of [null, undefined, "", "{", "null", "[]", "42", '"x"']) expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
  });
  test("junk values are dropped field by field", () => {
    expect(parseLayout(JSON.stringify({ sidebarCollapsed: "yes", sidebarWidth: "300", detailWidth: null }))).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{"sidebarWidth": 1e400}').sidebarWidth).toBeNull(); // Infinity
  });
  test("stored widths are clamped to the current bounds", () => {
    const l = parseLayout(JSON.stringify({ sidebarWidth: 5, detailWidth: 10 }));
    expect(l.sidebarWidth).toBe(SIDEBAR_MIN);
    expect(l.detailWidth).toBe(DETAIL_MIN);
    expect(parseLayout(JSON.stringify({ sidebarWidth: 9000 })).sidebarWidth).toBe(sidebarBounds().max);
    expect(sidebarBounds().max).toBe(SIDEBAR_MAX);
  });
});
