import { describe, expect, test } from "bun:test";
import { commandGoesToMain, parsePopoutOptions, POPOUT_OFFSET, POPOUT_START, popoutBounds } from "./popouts";

const work = { x: 0, y: 25, width: 1440, height: 875 };

describe("parsePopoutOptions", () => {
  test("takes a plain id with its own pop-out route, and numeric bounds", () => {
    const bounds = { x: 10, y: 20, width: 600, height: 400 };
    expect(parsePopoutOptions({ id: "a1-b2", route: "#/popout/a1-b2/*", bounds })).toEqual({ id: "a1-b2", route: "#/popout/a1-b2/*", bounds });
  });

  test("refuses ids that aren't plain, and routes that aren't this pop-out's", () => {
    expect(parsePopoutOptions({ id: "../x", route: "#/popout/../x/*" })).toBeNull();
    expect(parsePopoutOptions({ id: "a1", route: "#/popout/a2/*" })).toBeNull();
    expect(parsePopoutOptions({ id: "a1", route: "#/board/all" })).toBeNull();
    expect(parsePopoutOptions({ id: "a1" })).toBeNull();
    expect(parsePopoutOptions(null)).toBeNull();
  });

  test("drops bounds that aren't all numbers, keeping the rest", () => {
    expect(parsePopoutOptions({ id: "a1", route: "#/popout/a1/*", bounds: { x: 1, y: 2, width: "wide", height: 3 } })).toEqual({ id: "a1", route: "#/popout/a1/*" });
    expect(parsePopoutOptions({ id: "a1", route: "#/popout/a1/*", bounds: { x: NaN, y: 2, width: 3, height: 3 } })).toEqual({ id: "a1", route: "#/popout/a1/*" });
  });
});

describe("popoutBounds", () => {
  test("opens just down and right of where the pane was, at the pane's size", () => {
    expect(popoutBounds({ x: 700, y: 100, width: 620, height: 700 }, work)).toEqual({ x: 700 + POPOUT_OFFSET, y: 100 + POPOUT_OFFSET, width: 620, height: 700 });
  });

  test("a narrow pane gets a roomier window", () => {
    const b = popoutBounds({ x: 100, y: 100, width: 320, height: 200 }, work);
    expect([b.width, b.height]).toEqual([POPOUT_START.width, POPOUT_START.height]);
  });

  test("stays inside the work area, shrinking to fit when it's bigger", () => {
    expect(popoutBounds({ x: 1200, y: 700, width: 600, height: 500 }, work)).toEqual({ x: 1440 - 600, y: 25 + 875 - 500, width: 600, height: 500 });
    expect(popoutBounds({ x: -300, y: 0, width: 2000, height: 1200 }, work)).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });

  test("without the pane's spot it's centered (in whole pixels)", () => {
    const b = popoutBounds(undefined, work);
    expect(b).toEqual({ x: Math.round((1440 - POPOUT_START.width) / 2), y: Math.round(25 + (875 - POPOUT_START.height) / 2), width: POPOUT_START.width, height: POPOUT_START.height });
  });
});

describe("commandGoesToMain", () => {
  test("board-level commands go to the main window; the pane's own stay with the pop-out", () => {
    expect(["board", "inbox", "settings", "new-session", "new-terminal", "toggle-sidebar"].every(commandGoesToMain)).toBe(true);
    expect(["pane.close", "pane.popout", "palette", "tab.next"].some(commandGoesToMain)).toBe(false);
  });
});
