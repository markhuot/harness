import { describe, expect, test } from "bun:test";
import { clampWidth, DEFAULT_LAYOUT, dragWidth, keyWidth, parseLayout, serializeLayout, SIDEBAR_MAX, SIDEBAR_MIN, sidebarBounds } from "./layout";

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

describe("dragWidth", () => {
  const b = { min: 100, max: 500 };
  test("grows when dragged right and shrinks when dragged left", () => {
    expect(dragWidth(250, 250, 300, b)).toBe(300);
    expect(dragWidth(250, 250, 200, b)).toBe(200);
  });
  test("stops at the bounds", () => {
    expect(dragWidth(250, 250, 1000, b)).toBe(500);
    expect(dragWidth(250, 250, -1000, b)).toBe(100);
  });
});

describe("keyWidth", () => {
  const b = { min: 200, max: 600 };
  test("arrows move the handle in their direction", () => {
    expect(keyWidth("ArrowRight", false, 300, b)).toBe(316);
    expect(keyWidth("ArrowLeft", false, 300, b)).toBe(284);
    expect(keyWidth("ArrowLeft", true, 300, b)).toBe(236);
  });
  test("Home/End jump to the bounds and arrows clamp", () => {
    expect(keyWidth("Home", false, 300, b)).toBe(200);
    expect(keyWidth("End", false, 300, b)).toBe(600);
    expect(keyWidth("ArrowRight", true, 590, b)).toBe(600);
  });
  test("other keys aren't resize keys", () => {
    expect(keyWidth("Enter", false, 300, b)).toBeNull();
    expect(keyWidth("ArrowUp", false, 300, b)).toBeNull();
  });
});

describe("parseLayout", () => {
  test("round-trips", () => {
    const l = { sidebarCollapsed: true, sidebarWidth: 300 };
    expect(parseLayout(serializeLayout(l))).toEqual(l);
  });
  test("a stored detailWidth from before ticket panes is ignored", () => {
    expect(parseLayout(JSON.stringify({ sidebarCollapsed: true, sidebarWidth: 300, detailWidth: 720 }))).toEqual({ sidebarCollapsed: true, sidebarWidth: 300 });
  });
  test("missing or corrupt storage falls back to the defaults", () => {
    for (const raw of [null, undefined, "", "{", "null", "[]", "42", '"x"']) expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
  });
  test("junk values are dropped field by field", () => {
    expect(parseLayout(JSON.stringify({ sidebarCollapsed: "yes", sidebarWidth: "300" }))).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{"sidebarWidth": 1e400}').sidebarWidth).toBeNull(); // Infinity
  });
  test("stored widths are clamped to the current bounds", () => {
    expect(parseLayout(JSON.stringify({ sidebarWidth: 5 })).sidebarWidth).toBe(SIDEBAR_MIN);
    expect(parseLayout(JSON.stringify({ sidebarWidth: 9000 })).sidebarWidth).toBe(sidebarBounds().max);
    expect(sidebarBounds().max).toBe(SIDEBAR_MAX);
  });
});
