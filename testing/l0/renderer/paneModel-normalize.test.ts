import { beforeEach, describe, expect, test } from "bun:test";
import { BOARD_SHARE, checkPanes, normalize, resetPaneIds, leaves, type PaneNode } from "../../../app/src/renderer/state/paneModel";
import { board, col, compose, file, invariantErrors, leaf, row, shape, sizesOf, st, term, ticket, torn } from "./paneBuild";

beforeEach(() => resetPaneIds());

const near = (a: number[], b: number[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
};

describe("normalize", () => {
  test("a null root becomes just the board", () => {
    const s = normalize({ root: null });
    expect(s.root.type).toBe("leaf");
    expect(invariantErrors(s)).toEqual([]);
    expect(s.focusedId).toBeNull();
  });

  test("a tree without a board gets one on the left taking BOARD_SHARE", () => {
    const s = normalize({ root: ticket("t", "A-1") });
    expect(shape(s.root)).toMatch(/^row\(.+,t\)$/);
    near(sizesOf(s.root), [BOARD_SHARE, 1 - BOARD_SHARE]);
    expect(leaves(s.root)[0]!.content.kind).toBe("board");
    expect(invariantErrors(s)).toEqual([]);
  });

  test("a missing board joins a row-rooted tree by flattening into it", () => {
    const s = normalize({ root: row("r", [ticket("a", "A-1"), ticket("b", "A-2")], [0.5, 0.5]) });
    expect(s.root.type === "split" && s.root.children).toHaveLength(3);
    near(sizesOf(s.root), [BOARD_SHARE, (1 - BOARD_SHARE) / 2, (1 - BOARD_SHARE) / 2]);
  });

  test("later duplicate boards are dropped", () => {
    const s = normalize({ root: row("r", [board("B1"), board("B2"), ticket("t", "A-1")]) });
    expect(leaves(s.root).map((l) => l.id)).toEqual(["B1", "t"]);
  });

  test("later duplicate ticket keys, terminal sessions, composes, files and torn tabs are dropped", () => {
    const root = row("r", [
      board("B"), ticket("t1", "A-1"), ticket("t2", "A-1"), term("x1", "s"), term("x2", "s"), compose("n1", "n"), compose("n2", "n"),
      file("f1", "a"), file("f2", "a"), file("f3", "b"), torn("g1", "A-1", "transcript"), torn("g2", "A-1", "transcript"), torn("g3", "A-1", "browser", 1), torn("g4", "A-1", "browser", 2),
    ]);
    expect(leaves(normalize({ root }).root).map((l) => l.id)).toEqual(["B", "t1", "x1", "n1", "f1", "f3", "g1", "g3", "g4"]);
  });

  test("a ticket and its torn-off tab and its terminals' same-named things do not collide across kinds", () => {
    const root = row("r", [board("B"), ticket("t", "A-1"), torn("g", "A-1", "details"), file("f", "A-1", { ticketKey: "A-1" })]);
    expect(leaves(normalize({ root }).root)).toHaveLength(4);
  });

  test("terminals claimed by other scopes are dropped, and the kept ones are added to the claim", () => {
    const claimed = new Set(["taken"]);
    const s = normalize({ root: row("r", [board("B"), term("a", "taken"), term("b", "mine")]) }, new Set(), claimed);
    expect(leaves(s.root).map((l) => l.id)).toEqual(["B", "b"]);
    expect([...claimed].sort()).toEqual(["mine", "taken"]);
  });

  test("a single-child split collapses to the child; an empty split disappears", () => {
    const s = normalize({ root: row("r", [col("c", [board("B")]), col("e", [])]) });
    expect(shape(s.root)).toBe("B");
  });

  test("a same-direction nested split flattens, multiplying sizes", () => {
    const s = normalize({ root: row("r", [row("in", [board("B"), ticket("t", "A-1")], [0.5, 0.5]), ticket("u", "A-2")], [0.8, 0.2]) });
    expect(shape(s.root)).toBe("row(B,t,u)");
    near(sizesOf(s.root), [0.4, 0.4, 0.2]);
  });

  test("a different-direction nested split stays", () => {
    const s = normalize({ root: row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2")])]) });
    expect(shape(s.root)).toBe("row(B,col(a,b))");
  });

  test("removing a duplicate leaves the survivors' shares re-summed to 1", () => {
    const s = normalize({ root: row("r", [board("B"), ticket("t1", "A-1"), ticket("t2", "A-1")], [0.5, 0.25, 0.25]) });
    near(sizesOf(s.root), [2 / 3, 1 / 3]);
  });

  test("unusable sizes (wrong length, zero, negative, NaN, Infinity, strings) even out", () => {
    const kids = (): PaneNode[] => [board("B"), ticket("a", "A-1"), ticket("b", "A-2")];
    for (const sizes of [[1, 2], [1, 0, 1], [1, -1, 1], [1, Number.NaN, 1], [1, Infinity, 1], [1, "x" as unknown as number, 1], []]) {
      near(sizesOf(normalize({ root: { ...row("r", kids()), sizes } }).root), [1 / 3, 1 / 3, 1 / 3]);
    }
  });

  test("good sizes that do not sum to 1 are scaled, keeping proportions", () => {
    near(sizesOf(normalize({ root: row("r", [board("B"), ticket("a", "A-1")], [3, 1]) }).root), [0.75, 0.25]);
  });

  test("duplicate and empty ids are re-minted; the first holder keeps its id", () => {
    const s = normalize({ root: row("r", [board("x"), ticket("x", "A-1"), ticket("", "A-2")]) });
    const ids = leaves(s.root).map((l) => l.id);
    expect(ids[0]).toBe("x");
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(Boolean)).toBe(true);
    expect(invariantErrors(s)).toEqual([]);
  });

  test("a split sharing an id with a leaf gets a new one", () => {
    const s = normalize({ root: row("same", [board("same"), ticket("t", "A-1")]) });
    expect(invariantErrors(s)).toEqual([]);
  });

  test("reserved ids (other scopes') are never used, even by the first holder", () => {
    const s = normalize({ root: row("r", [board("B"), ticket("t", "A-1")]) }, new Set(["B", "r"]));
    const all = [s.root.id, ...leaves(s.root).map((l) => l.id)];
    expect(all).not.toContain("B");
    expect(all).not.toContain("r");
    expect(leaves(s.root).find((l) => l.content.kind === "ticket")!.id).toBe("t");
  });

  test("fresh ids skip ids already taken", () => {
    const s = normalize({ root: row("r", [board("p1"), ticket("", "A-1"), ticket("p2", "A-2")]) });
    expect(invariantErrors(s)).toEqual([]);
  });

  test("focus and zoom on a leaf survive; on a split, a dropped leaf, or an unknown id they become null", () => {
    const root = row("r", [board("B"), ticket("t1", "A-1"), ticket("t2", "A-1")]);
    expect(normalize({ root, focusedId: "t1", zoomedId: "B" })).toMatchObject({ focusedId: "t1", zoomedId: "B" });
    expect(normalize({ root, focusedId: "r", zoomedId: "t2" })).toMatchObject({ focusedId: null, zoomedId: null });
    expect(normalize({ root, focusedId: undefined, zoomedId: "ghost" })).toMatchObject({ focusedId: null, zoomedId: null });
    expect(normalize({ root, focusedId: "" })).toMatchObject({ focusedId: null });
  });

  test("is idempotent", () => {
    const messy = row("r", [row("in", [ticket("a", "A-1"), ticket("a", "A-1")]), col("c", [term("x", "s"), term("y", "s")]), ticket("", "A-2")], [1, 2, 3]);
    const once = normalize({ root: messy, focusedId: "a" });
    expect(normalize(once)).toEqual(once);
  });
});

describe("checkPanes", () => {
  test("a valid state has no errors", () => {
    expect(checkPanes(st(row("r", [board("B"), ticket("t", "A-1")], [0.6, 0.4]), "t", "B"))).toEqual([]);
  });

  const errors = (root: PaneNode, focused: string | null = null, zoomed: string | null = null) => checkPanes(st(root, focused, zoomed));

  test("board count", () => {
    expect(errors(ticket("t", "A-1"))).toContain("0 board leaves");
    expect(errors(row("r", [board("a"), board("b")]))).toContain("2 board leaves");
  });
  test("duplicated tickets, terminals, composes, files, torn tabs", () => {
    const errs = errors(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-1"), term("x", "s"), term("y", "s"), compose("n", "k"), compose("m", "k"), file("f", "p"), file("g", "p"), torn("t1", "A-1"), torn("t2", "A-1")], [0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05]));
    expect(errs.join("|")).toMatch(/ticket A-1 is open twice/);
    expect(errs.join("|")).toMatch(/terminal s is open twice/);
    expect(errs.join("|")).toMatch(/New session k is open twice/);
    expect(errs.join("|")).toMatch(/file p is open twice/);
    expect(errs.join("|")).toMatch(/is torn off twice/);
  });
  test("structure: one child, size count, non-positive size, sum, same-dir nesting, ids", () => {
    expect(errors(row("r", [board("B")]))).toContain("split r has 1 children");
    expect(errors({ ...row("r", [board("B"), ticket("t", "A-1")]), sizes: [1] }).join("|")).toMatch(/1 sizes for 2 children/);
    expect(errors(row("r", [board("B"), ticket("t", "A-1")], [1, 0])).join("|")).toMatch(/non-positive/);
    expect(errors(row("r", [board("B"), ticket("t", "A-1")], [Number.NaN, 1])).join("|")).toMatch(/non-positive/);
    expect(errors(row("r", [board("B"), ticket("t", "A-1")], [0.5, 0.6])).join("|")).toMatch(/sum to 1.1/);
    expect(errors(row("r", [board("B"), row("in", [ticket("a", "A-1"), ticket("b", "A-2")])])).join("|")).toMatch(/nests in r with the same dir/);
    expect(errors(row("r", [board("B"), ticket("B", "A-1")]))).toContain("id B is used twice");
    expect(errors(row("r", [board("B"), ticket("", "A-1")]))).toContain("a node has no id");
  });
  test("focus and zoom must name a leaf", () => {
    const root = row("r", [board("B"), ticket("t", "A-1")]);
    expect(errors(root, "r")).toContain("focusedId r is not a leaf");
    expect(errors(root, null, "ghost")).toContain("zoomedId ghost is not a leaf");
    expect(errors(root, "t", "B")).toEqual([]);
  });
  test("unrelated kinds are not duplicates of each other", () => {
    expect(errors(row("r", [board("B"), leaf("a", { kind: "ticket", ticketKey: "A-1", tab: "spec" }), torn("b", "A-1", "details")]))).toEqual([]);
  });
});
