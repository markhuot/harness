import { describe, expect, test } from "bun:test";
import { clampWidth, DEFAULT_LAYOUT, dragWidth, keyWidth, parseLayout, serializeLayout, SIDEBAR_MAX, SIDEBAR_MIN, sidebarBounds } from "../../../app/src/renderer/state/layoutRules";

const b = { min: 100, max: 300 };

describe("clampWidth", () => {
  test("rounds, then clamps to each end", () => {
    expect(clampWidth(150.6, b)).toBe(151);
    expect(clampWidth(50, b)).toBe(100);
    expect(clampWidth(999, b)).toBe(300);
    expect(clampWidth(100, b)).toBe(100);
    expect(clampWidth(300, b)).toBe(300);
  });

  test("the minimum wins when the room is smaller than it", () => {
    expect(clampWidth(500, { min: 100, max: 40 })).toBe(100);
    expect(clampWidth(10, { min: 100, max: 40 })).toBe(100);
  });
});

describe("dragWidth", () => {
  test("dragging right widens, left narrows, both clamped", () => {
    expect(dragWidth(200, 10, 30, b)).toBe(220);
    expect(dragWidth(200, 30, 10, b)).toBe(180);
    expect(dragWidth(200, 0, 500, b)).toBe(300);
    expect(dragWidth(200, 500, 0, b)).toBe(100);
  });
});

describe("keyWidth", () => {
  test("arrows step 16px, 64px with shift, clamped", () => {
    expect(keyWidth("ArrowRight", false, 200, b)).toBe(216);
    expect(keyWidth("ArrowLeft", false, 200, b)).toBe(184);
    expect(keyWidth("ArrowRight", true, 200, b)).toBe(264);
    expect(keyWidth("ArrowLeft", true, 200, b)).toBe(136);
    expect(keyWidth("ArrowRight", true, 290, b)).toBe(300);
    expect(keyWidth("ArrowLeft", false, 105, b)).toBe(100);
  });

  test("Home and End jump to the extremes", () => {
    expect(keyWidth("Home", false, 200, b)).toBe(100);
    expect(keyWidth("End", false, 200, b)).toBe(300);
  });

  test("End with a max below the min lands on the min", () => {
    expect(keyWidth("End", false, 200, { min: 100, max: 40 })).toBe(100);
  });

  test("other keys are not resize keys", () => {
    expect(keyWidth("ArrowUp", false, 200, b)).toBeNull();
    expect(keyWidth("a", true, 200, b)).toBeNull();
    expect(keyWidth("", false, 200, b)).toBeNull();
  });
});

describe("parseLayout", () => {
  test("missing or empty input gives the defaults, as a copy", () => {
    for (const raw of [null, undefined, ""]) {
      const l = parseLayout(raw);
      expect(l).toEqual(DEFAULT_LAYOUT);
      expect(l).not.toBe(DEFAULT_LAYOUT);
    }
  });

  test("corrupt JSON, arrays, null and scalars give the defaults", () => {
    for (const raw of ["{oops", "[1,2]", "null", "7", '"str"', "true"]) expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
  });

  test("reads a good layout", () => {
    const stored = { sidebarCollapsed: true, sidebarWidth: 250, browserSizeRow: true, usageFilter: "claude", usageMode: "projected" };
    expect(parseLayout(JSON.stringify(stored))).toEqual(stored);
  });

  test("sidebar width is rounded and clamped to the sidebar bounds", () => {
    expect(parseLayout('{"sidebarWidth":5}').sidebarWidth).toBe(SIDEBAR_MIN);
    expect(parseLayout('{"sidebarWidth":9999}').sidebarWidth).toBe(SIDEBAR_MAX);
    expect(parseLayout('{"sidebarWidth":200.4}').sidebarWidth).toBe(200);
    expect(sidebarBounds()).toEqual({ min: SIDEBAR_MIN, max: SIDEBAR_MAX });
  });

  test("junk field values fall back per field without spoiling the others", () => {
    const l = parseLayout(JSON.stringify({ sidebarCollapsed: "yes", sidebarWidth: "wide", browserSizeRow: 1, usageFilter: 5, usageMode: "weird", detailWidth: 400 }));
    expect(l).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{"sidebarWidth":null,"sidebarCollapsed":true}')).toEqual({ ...DEFAULT_LAYOUT, sidebarCollapsed: true });
    expect("detailWidth" in l).toBe(false);
  });

  test("non-finite widths do not survive (JSON null for NaN/Infinity)", () => {
    expect(parseLayout('{"sidebarWidth":null}').sidebarWidth).toBeNull();
  });

  test("an empty usageFilter string falls back to all", () => {
    expect(parseLayout('{"usageFilter":""}').usageFilter).toBe("all");
  });

  test("serialize then parse round-trips", () => {
    const l = { ...DEFAULT_LAYOUT, sidebarWidth: 300, usageFilter: "hide" };
    expect(parseLayout(serializeLayout(l))).toEqual(l);
  });
});
