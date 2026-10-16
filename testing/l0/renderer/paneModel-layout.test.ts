import { describe, expect, test } from "bun:test";
import {
  clampSizes, keySplit, layoutPanes, paneInDirection, PANE_MIN_WIDTH, resizeSplit, type PaneDir, type PaneState,
} from "../../../app/src/renderer/state/paneModel";
import { board, col, row, st, ticket } from "./paneBuild";

const near = (a: readonly number[], b: readonly number[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
};
const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
const boxOf = (s: PaneState, id: string, area?: { width: number; height: number }) => layoutPanes(s, area).leaves.find((l) => l.leaf.id === id)!;

describe("layoutPanes", () => {
  test("a lone pane fills the area", () => {
    const l = layoutPanes(st(board("B")));
    expect(l.leaves).toHaveLength(1);
    expect(l.leaves[0]!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(l.dividers).toEqual([]);
    expect(l.cornerId).toBe("B");
  });

  test("rows go left to right, columns top to bottom, nested boxes inside their parent's", () => {
    const s = st(row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2")], [0.25, 0.75])], [0.6, 0.4]));
    near(Object.values(boxOf(s, "B").rect), [0, 0, 0.6, 1]);
    near(Object.values(boxOf(s, "a").rect), [0.6, 0, 0.4, 0.25]);
    near(Object.values(boxOf(s, "b").rect), [0.6, 0.25, 0.4, 0.75]);
  });

  test("a divider sits between each pair of children, at the boundary", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.5, 0.3, 0.2]));
    const l = layoutPanes(s);
    expect(l.dividers.map((d) => d.index)).toEqual([0, 1]);
    near(l.dividers.map((d) => d.at), [0.5, 0.8]);
    expect(l.dividers[0]!.split.id).toBe("r");
    near(l.dividers[0]!.sizes, [0.5, 0.3, 0.2]);
    const c = layoutPanes(st(row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2")], [0.4, 0.6])])));
    const colDivider = c.dividers.find((d) => d.split.id === "c")!;
    expect(colDivider.at).toBeCloseTo(0.4, 9); // y, along the column
    expect(colDivider.rect.x).toBeCloseTo(0.5, 9);
  });

  test("zoom: the zoomed pane fills everything, the rest are hidden, no dividers", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")]), "a", "a");
    const l = layoutPanes(s);
    expect(l.leaves.find((b) => b.leaf.id === "a")).toMatchObject({ rect: { x: 0, y: 0, w: 1, h: 1 }, hidden: false });
    expect(l.leaves.find((b) => b.leaf.id === "B")!.hidden).toBe(true);
    expect(l.dividers).toEqual([]);
    expect(l.cornerId).toBe("a");
  });

  test("the corner is the first leaf", () => {
    expect(layoutPanes(st(row("r", [col("c", [ticket("a", "A-1"), board("B")]), ticket("b", "A-2")]))).cornerId).toBe("a");
  });

  test("with an area, sizes below the minimums are raised and the stored sizes stay untouched", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.9, 0.1]));
    const l = layoutPanes(s, { width: 1000, height: 800 });
    near(Object.values(l.leaves[0]!.rect), [0, 0, 0.64, 1]);
    near(Object.values(l.leaves[1]!.rect), [0.64, 0, 0.36, 1]);
    near(l.dividers[0]!.sizes, [0.64, 0.36]);
    near(s.root.type === "split" ? s.root.sizes : [], [0.9, 0.1]);
  });

  test("columns are clamped on the height", () => {
    const s = st(col("c", [board("B"), ticket("a", "A-1")], [0.95, 0.05]));
    near(Object.values(boxOf(s, "a", { width: 1000, height: 1000 }).rect), [0, 0.8, 1, 0.2]);
  });

  test("when the minimums can't fit, space is shared in proportion to them", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]));
    const w = 400;
    near(Object.values(boxOf(s, "B", { width: w, height: 800 }).rect), [0, 0, PANE_MIN_WIDTH.board / (PANE_MIN_WIDTH.board + PANE_MIN_WIDTH.ticket), 1]);
  });

  test("sizes already fitting are untouched by an area", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.6, 0.4]));
    near(Object.values(boxOf(s, "B", { width: 2000, height: 800 }).rect), [0, 0, 0.6, 1]);
  });
});

describe("paneInDirection", () => {
  // B | (a over b)   and, to the right of that, a tall c
  const s = st(row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2")]), ticket("t", "A-3")], [0.3, 0.3, 0.4]));
  const layout = layoutPanes(s);
  const go = (from: string, dir: PaneDir, opts?: { sidebar?: boolean }) => paneInDirection(layout, from, dir, opts);

  test("left and right move to the adjacent column, up and down within a stack", () => {
    expect(go("t", "left")).toBe("a"); // a and b overlap t equally: the topmost wins
    expect(go("a", "right")).toBe("t");
    expect(go("a", "left")).toBe("B");
    expect(go("a", "down")).toBe("b");
    expect(go("b", "up")).toBe("a");
  });

  test("nothing beyond an edge gives null", () => {
    expect(go("a", "up")).toBeNull();
    expect(go("b", "down")).toBeNull();
    expect(go("t", "right")).toBeNull();
    expect(go("B", "up")).toBeNull();
    expect(go("B", "left")).toBeNull();
  });

  test("moving left off the workspace's left edge reaches the sidebar only when it is open", () => {
    expect(go("B", "left", { sidebar: true })).toBe("sidebar");
    expect(go("B", "left", { sidebar: false })).toBeNull();
    expect(go("B", "up", { sidebar: true })).toBeNull();
    expect(go("t", "right", { sidebar: true })).toBeNull();
  });

  test("a pane found to the left beats the sidebar", () => {
    expect(go("a", "left", { sidebar: true })).toBe("B");
  });

  test("with no left neighbour but not at the edge there is no sidebar jump", () => {
    const z = layoutPanes(st(row("r", [ticket("a", "A-1"), board("B")]), null, null));
    expect(paneInDirection(z, "B", "left", { sidebar: true })).toBe("a");
  });

  test("the nearest pane wins over a farther one", () => {
    const l = layoutPanes(st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")])));
    expect(paneInDirection(l, "B", "right")).toBe("a");
    expect(paneInDirection(l, "b", "left")).toBe("a");
  });

  test("among equally near panes the one sharing most of the edge wins", () => {
    const l = layoutPanes(st(row("r", [ticket("t", "A-3"), col("c", [board("B"), ticket("a", "A-1")], [0.2, 0.8])]), "t"));
    // t spans the whole height; to its right B takes 20% and a 80%
    expect(paneInDirection(l, "t", "right")).toBe("a");
    const wide = layoutPanes(st(col("c", [row("x", [board("B"), ticket("a", "A-1")], [0.8, 0.2]), ticket("t", "A-3")])));
    expect(paneInDirection(wide, "t", "up")).toBe("B");
  });

  test("a pane that only touches at a corner is not a neighbour", () => {
    const l = layoutPanes(st(row("r", [col("c1", [board("B"), ticket("a", "A-1")]), col("c2", [ticket("b", "A-2"), ticket("d", "A-4")])])));
    expect(paneInDirection(l, "B", "down")).toBe("a");
    expect(paneInDirection(l, "B", "right")).toBe("b");
    expect(paneInDirection(l, "a", "right")).toBe("d");
  });

  test("an unknown or hidden origin gives null, and hidden panes are never landed on", () => {
    const z = layoutPanes(st(row("r", [board("B"), ticket("a", "A-1")]), "a", "a"));
    expect(paneInDirection(z, "B", "right")).toBeNull(); // the origin is hidden
    expect(paneInDirection(z, "a", "left")).toBeNull(); // B is hidden under the zoom
    expect(paneInDirection(layout, "ghost", "left")).toBeNull();
  });
});

describe("clampSizes", () => {
  test("sizes that already fit come back unchanged", () => {
    near(clampSizes([0.5, 0.5], [100, 100], 1000), [0.5, 0.5]);
    near(clampSizes([0.2, 0.3, 0.5], [0, 0, 0], 1000), [0.2, 0.3, 0.5]);
  });
  test("a child below its minimum is raised, the rest share what's left in proportion", () => {
    near(clampSizes([0.1, 0.3, 0.6], [300, 100, 100], 1000), [0.3, 0.7 / 3, 0.7 * 2 / 3]);
  });
  test("raising one child can push another below its minimum (repeats until none is short)", () => {
    const out = clampSizes([0.05, 0.4, 0.55], [400, 350, 100], 1000);
    near(out, [0.4, 0.35, 0.25]);
    expect(sum(out)).toBeCloseTo(1, 9);
  });
  test("when the minimums don't all fit, space follows the minimums", () => {
    near(clampSizes([0.9, 0.1], [300, 100], 200), [0.75, 0.25]);
    near(clampSizes([0.5, 0.5], [100, 100], 200), [0.5, 0.5]); // exactly enough
  });
  test("an unusable total or mismatched lengths return the sizes as they were", () => {
    for (const total of [0, -10, Number.NaN]) near(clampSizes([0.3, 0.7], [100, 100], total), [0.3, 0.7]);
    near(clampSizes([0.3, 0.7], [100], 1000), [0.3, 0.7]);
  });
  test("returns a copy, not the input array", () => {
    const sizes = [0.3, 0.7];
    expect(clampSizes(sizes, [100], 1000)).not.toBe(sizes);
  });
  test("zero stored sizes are shared out evenly rather than dividing by zero", () => {
    near(clampSizes([0, 0], [100, 100], 1000), [0.5, 0.5]);
  });
});

describe("resizeSplit", () => {
  test("dragging a divider moves room between the two sides", () => {
    near(resizeSplit([0.5, 0.5], 0, 100, 1000, 100), [0.6, 0.4]);
    near(resizeSplit([0.5, 0.5], 0, -100, 1000, 100), [0.4, 0.6]);
  });
  test("no child goes below the minimum", () => {
    near(resizeSplit([0.5, 0.5], 0, 900, 1000, 100), [0.9, 0.1]);
    near(resizeSplit([0.5, 0.5], 0, -900, 1000, 100), [0.1, 0.9]);
  });
  test("every child on a side scales alike (dragging the last divider left grows the last pane, shrinks the others in proportion)", () => {
    near(resizeSplit([0.2, 0.3, 0.5], 1, -100, 1000, 50), [0.16, 0.24, 0.6]);
  });
  test("pair mode only changes the two children touching the divider", () => {
    near(resizeSplit([0.2, 0.3, 0.5], 0, 100, 1000, 50, true), [0.3, 0.2, 0.5]);
    near(resizeSplit([0.2, 0.3, 0.5], 1, -100, 1000, 50, true), [0.2, 0.2, 0.6]);
  });
  test("a child that reaches its minimum stays there while the rest keep shrinking", () => {
    near(resizeSplit([0.1, 0.4, 0.5], 1, -250, 1000, 100), [0.1, 0.15, 0.75]);
  });
  test("per-child minimums", () => {
    near(resizeSplit([0.5, 0.5], 0, -900, 1000, [300, 100]), [0.3, 0.7]);
    near(resizeSplit([0.5, 0.5], 0, 900, 1000, [300, 100]), [0.9, 0.1]);
    near(resizeSplit([0.5, 0.5], 0, 900, 1000, [300]), [1, 0]); // a missing minimum counts as 0
  });
  test("Infinity (Home/End) goes as far as the minimums allow", () => {
    near(resizeSplit([0.5, 0.5], 0, Infinity, 1000, 100), [0.9, 0.1]);
    near(resizeSplit([0.5, 0.5], 0, -Infinity, 1000, 100), [0.1, 0.9]);
  });
  test("without room for every minimum, the space follows the minimums", () => {
    near(resizeSplit([0.5, 0.5], 0, 50, 200, [100, 300]), [0.25, 0.75]);
    near(resizeSplit([0.5, 0.5], 0, 50, 100, 100), [0.5, 0.5]);
  });
  test("an index with no divider, a useless total or a NaN delta returns the sizes unchanged", () => {
    const sizes = [0.4, 0.6];
    for (const out of [resizeSplit(sizes, -1, 50, 1000, 100), resizeSplit(sizes, 1, 50, 1000, 100), resizeSplit(sizes, 5, 50, 1000, 100), resizeSplit(sizes, 0, 50, 0, 100), resizeSplit(sizes, 0, 50, Number.NaN, 100), resizeSplit(sizes, 0, Number.NaN, 1000, 100)]) {
      near(out, sizes);
      expect(out).not.toBe(sizes);
    }
  });
  test("always sums to 1 and stays positive across a sweep", () => {
    for (const delta of [-5000, -321, -1, 0, 1, 77, 400, 5000]) {
      for (const pair of [false, true]) {
        for (let index = 0; index < 3; index++) {
          const out = resizeSplit([0.1, 0.2, 0.3, 0.4], index, delta, 1200, [100, 150, 100, 200], pair);
          expect(sum(out)).toBeCloseTo(1, 9);
          expect(out.every((x) => x > 0)).toBe(true);
        }
      }
    }
  });
});

describe("keySplit", () => {
  const sizes = [0.5, 0.5];
  test("rows use left/right, columns up/down, 16px or 64px with shift", () => {
    near(keySplit("ArrowRight", false, "row", sizes, 0, 1000, 100)!, [0.516, 0.484]);
    near(keySplit("ArrowLeft", false, "row", sizes, 0, 1000, 100)!, [0.484, 0.516]);
    near(keySplit("ArrowRight", true, "row", sizes, 0, 1000, 100)!, [0.564, 0.436]);
    near(keySplit("ArrowDown", false, "column", sizes, 0, 1000, 100)!, [0.516, 0.484]);
    near(keySplit("ArrowUp", true, "column", sizes, 0, 1000, 100)!, [0.436, 0.564]);
  });
  test("the other axis's arrows are not resize keys", () => {
    expect(keySplit("ArrowUp", false, "row", sizes, 0, 1000, 100)).toBeNull();
    expect(keySplit("ArrowDown", false, "row", sizes, 0, 1000, 100)).toBeNull();
    expect(keySplit("ArrowLeft", false, "column", sizes, 0, 1000, 100)).toBeNull();
    expect(keySplit("ArrowRight", false, "column", sizes, 0, 1000, 100)).toBeNull();
  });
  test("Home and End go all the way, in either direction; other keys are null", () => {
    near(keySplit("Home", false, "row", sizes, 0, 1000, 100)!, [0.1, 0.9]);
    near(keySplit("End", false, "column", sizes, 0, 1000, 100)!, [0.9, 0.1]);
    expect(keySplit("Enter", false, "row", sizes, 0, 1000, 100)).toBeNull();
  });
  test("pair mode is passed through", () => {
    near(keySplit("ArrowRight", false, "row", [0.2, 0.3, 0.5], 0, 1000, 50, true)!, [0.216, 0.284, 0.5]);
    near(keySplit("ArrowRight", false, "row", [0.2, 0.3, 0.5], 0, 1000, 50)!, [0.216, 0.294, 0.49]);
  });
});
