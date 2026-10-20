import { describe, expect, test } from "bun:test";
import { cyclePaneWidth, layoutPanes, setPaneWidth, type PaneState } from "../../../app/src/renderer/state/paneModel";
import { board, col, invariantErrors, row, st, ticket } from "./paneBuild";

const area = { width: 1600, height: 900 };
/** Every pane's on-screen width in px. */
const px = (s: PaneState, a = area) => Object.fromEntries(layoutPanes(s, a).leaves.map((l) => [l.leaf.id, Math.round(l.rect.w * a.width)]));
/** Cycle `n` times, checking the tree stays valid. */
const cycle = (s: PaneState, n = 1, win = area.width, a = area) => {
  for (let i = 0; i < n; i++) {
    s = cyclePaneWidth(s, a, win);
    expect(invariantErrors(s)).toEqual([]);
  }
  return s;
};

describe("cyclePaneWidth", () => {
  test("from a width on the list it moves to the next wider, skips what can't fit, and wraps", () => {
    // 10% and 20% (160, 320px) are below the ticket's 360px minimum; 33% is 533, 50% is 800
    let s = st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]), "a");
    s = cycle(s);
    expect(px(s)).toEqual({ B: 1200, a: 400 }); // 800 → wraps to 25%
    s = cycle(s);
    expect(px(s)).toEqual({ B: 1067, a: 533 });
    s = cycle(s);
    expect(px(s)).toEqual({ B: 800, a: 800 });
  });

  test("from a width not on the list it snaps to the closest, even a narrower one", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.6, 0.4]), "a"); // a is 640px: 533 is closest
    expect(px(cycle(s))).toEqual({ B: 1067, a: 533 });
    const wide = st(row("r", [board("B"), ticket("a", "A-1")], [0.3, 0.7]), "a"); // 1120px: closest is 800
    expect(px(cycle(wide))).toEqual({ B: 800, a: 800 });
  });

  test("a neighbour's width is a stop, and only the pane and the board move", () => {
    let s = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.3, 0.4, 0.3]), "b"); // 480, 640, 480
    s = cycle(s); // 480 is closest to 533
    expect(px(s)).toEqual({ B: 427, a: 640, b: 533 });
    s = cycle(s); // next is the left neighbour's 640 (800 would leave the board 160px)
    expect(px(s)).toEqual({ B: 320, a: 640, b: 640 });
    s = cycle(s); // nothing wider fits: back to the narrowest, 400
    expect(px(s)).toEqual({ B: 560, a: 640, b: 400 });
  });

  test("the board as a neighbour counts as the width where the two are equal", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.75, 0.25]), "a"); // a 400px, window so small only that candidate fits
    expect(px(cycle(s, 1, 400))).toEqual({ B: 800, a: 800 });
  });

  test("widths that break a minimum are skipped, not clamped", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.7, 0.3]), "a"); // 480px; 10-33% of 400 are all under 360
    expect(px(cycle(s, 1, 400))).toEqual({ B: 800, a: 800 });
  });

  test("it starts from the width on screen, not the stored size a narrow window clamped", () => {
    const narrow = { width: 1000, height: 600 };
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.9, 0.1]), "a"); // stored 100px, shown 360px
    expect(px(s, narrow)).toEqual({ B: 640, a: 360 });
    expect(px(cycle(s, 1, 1000, narrow), narrow)).toEqual({ B: 500, a: 500 });
  });

  test("a row nested beside the board keeps its other panes' widths; panes stacked with it follow", () => {
    const tree = row("r", [board("B"), col("c", [row("in", [ticket("a", "A-1"), ticket("b", "A-2")]), ticket("t", "A-3")])]);
    const s = st(tree, "a"); // a and b 400px each, the column 800px
    expect(px(s)).toEqual({ B: 800, a: 400, b: 400, t: 800 });
    expect(px(cycle(s))).toEqual({ B: 667, a: 533, b: 400, t: 933 });
  });

  test("the board stacked above the pane leaves nothing to take room from", () => {
    const s = st(col("c", [board("B"), row("r", [ticket("a", "A-1"), ticket("b", "A-2")])]), "a");
    expect(cyclePaneWidth(s, area, 1600)).toBe(s);
  });

  test("nothing happens for the board, a zoomed pane, no focus, or a window with no board", () => {
    const tree = row("r", [board("B"), ticket("a", "A-1")]);
    for (const s of [st(tree, "B"), st(tree, "a", "a"), st(tree, null), st(row("r", [ticket("a", "A-1"), ticket("b", "A-2")]), "a")]) {
      expect(cyclePaneWidth(s, area, 1600)).toBe(s);
    }
  });

  test("when the width is the only one that fits, it stays", () => {
    const small = { width: 800, height: 600 };
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]), "a"); // only 400px (50%) fits both minimums
    expect(cyclePaneWidth(s, small, 800)).toBe(s);
  });
});

describe("setPaneWidth", () => {
  test("returns the state itself when the width can't be shown or is already there", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]), "a");
    expect(setPaneWidth(s, area, 300)).toBe(s); // under the minimum
    expect(setPaneWidth(s, area, 1400)).toBe(s); // leaves the board 200px
    expect(setPaneWidth(s, area, 800)).toBe(s);
    expect(px(setPaneWidth(s, area, 600))).toEqual({ B: 1000, a: 600 });
  });
});
