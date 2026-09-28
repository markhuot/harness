import { beforeEach, describe, expect, test } from "bun:test";
import {
  boardLeaf,
  checkPanes,
  closePane,
  defaultPanes,
  dropContent,
  findLeaf,
  focusPane,
  keySplit,
  leaves,
  movePane,
  normalize,
  openTicket,
  parsePanes,
  pruneTickets,
  renameTicketKey,
  replaceContent,
  resetPaneIds,
  resizeSplit,
  serializePanes,
  setSizes,
  setTab,
  ticketLeafByKey,
  toggleZoom,
  type PaneContent,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
  type PaneState,
} from "./panes";

// Builders: leaf ids are the ticket key (or "B" for the board) so shapes and focus read naturally.
const B: PaneLeaf = { type: "leaf", id: "B", content: { kind: "board" } };
const T = (key: string, tab: "summaries" | "transcript" = "summaries"): PaneLeaf => ({ type: "leaf", id: key, content: { kind: "ticket", ticketKey: key, tab } });
const split = (dir: "row" | "column", id: string, children: PaneNode[], sizes?: number[]): PaneSplit => ({
  type: "split",
  id,
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
});
const row = (id: string, children: PaneNode[], sizes?: number[]) => split("row", id, children, sizes);
const col = (id: string, children: PaneNode[], sizes?: number[]) => split("column", id, children, sizes);
const st = (root: PaneNode, focusedId: string | null = null, zoomedId: string | null = null): PaneState => ({ root, focusedId, zoomedId });

const ticketContent = (key: string, tab: "summaries" | "transcript" = "summaries"): PaneContent => ({ kind: "ticket", ticketKey: key, tab });
const label = (l: PaneLeaf) => (l.content.kind === "board" ? "board" : l.content.ticketKey);
const r = (n: number) => Math.round(n * 1000) / 1000;
/** A compact picture of a tree: row[board .6, col[A .5, B .5] .4] */
function shape(n: PaneNode): string {
  if (n.type === "leaf") return label(n);
  const kids = n.children.map((c, i) => `${shape(c)} ${r(n.sizes[i]!)}`);
  return `${n.dir === "row" ? "row" : "col"}[${kids.join(", ")}]`;
}
/** Every op's result must satisfy every invariant. */
function valid(s: PaneState): PaneState {
  expect(checkPanes(s)).toEqual([]);
  return s;
}
const focusedLabel = (s: PaneState) => (s.focusedId ? label(findLeaf(s.root, s.focusedId)!) : null);

beforeEach(() => resetPaneIds());

describe("defaultPanes", () => {
  test("is a single board leaf", () => {
    const s = valid(defaultPanes());
    expect(shape(s.root)).toBe("board");
  });
});

describe("normalize / checkPanes", () => {
  test("checkPanes catches each broken invariant", () => {
    const bad = st(
      row("r", [B, { ...B, id: "B2" }, row("r2", [T("A-1"), { ...T("A-1"), id: "dup" }], [0.5, 0.5]), col("c", [T("A-2")], [1])], [0.5, 0.5, -1, 0.2]),
      "nope",
      "gone",
    );
    const errors = checkPanes(bad).join("\n");
    expect(errors).toContain("2 board leaves");
    expect(errors).toContain("A-1 is open twice");
    expect(errors).toContain("split c has 1 children");
    expect(errors).toContain("r2 nests in r with the same dir");
    expect(errors).toContain("split r has a non-positive size");
    expect(errors).toContain("focusedId nope");
    expect(errors).toContain("zoomedId gone");
  });

  test("collapses single-child splits and drops empty ones", () => {
    const s = valid(normalize(st(row("r", [col("c", [B], [1]), row("empty", [], [])], [0.5, 0.5]))));
    expect(shape(s.root)).toBe("board");
  });

  test("flattens a same-dir child, scaling its sizes by the child's share", () => {
    const s = valid(normalize(st(row("r", [B, row("r2", [T("A-1"), T("A-2")], [0.25, 0.75])], [0.6, 0.4]))));
    expect(shape(s.root)).toBe("row[board 0.6, A-1 0.1, A-2 0.3]");
  });

  test("flattens through a collapsed split: row > column(one child) > row", () => {
    const s = valid(normalize(st(row("r", [B, col("c", [row("r2", [T("A-1"), T("A-2")])], [1])], [0.5, 0.5]))));
    expect(shape(s.root)).toBe("row[board 0.5, A-1 0.25, A-2 0.25]");
  });

  test("keeps the first board and the first leaf per ticket key", () => {
    const s = valid(normalize(st(row("r", [T("A-1"), B, { ...B, id: "B2" }, { ...T("A-1", "transcript"), id: "x" }]))));
    expect(shape(s.root)).toBe("row[A-1 0.5, board 0.5]");
    expect(boardLeaf(s.root)!.id).toBe("B");
    expect(findLeaf(s.root, "x")).toBeNull();
  });

  test("brings a missing board back on the left", () => {
    expect(shape(valid(normalize(st(T("A-1")))).root)).toBe("row[board 0.6, A-1 0.4]");
    expect(shape(valid(normalize(st(row("r", [T("A-1"), T("A-2")])))).root)).toBe("row[board 0.6, A-1 0.2, A-2 0.2]");
    expect(shape(valid(normalize({ root: null })).root)).toBe("board");
  });

  test("renumbers duplicate and empty ids, keeping the first holder's", () => {
    const s = valid(normalize(st(row("r", [B, { ...T("A-1"), id: "B" }, { ...T("A-2"), id: "" }]))));
    const ids = leaves(s.root).map((l) => l.id);
    expect(ids[0]).toBe("B");
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain("");
  });

  test("fixes bad sizes: wrong count, zero, negative, NaN, and not summing to 1", () => {
    for (const sizes of [[1], [0, 1], [-1, 2], [NaN, 1], [Infinity, 1]]) {
      expect(shape(valid(normalize(st(row("r", [B, T("A-1")], sizes)))).root)).toBe("row[board 0.5, A-1 0.5]");
    }
    expect(shape(valid(normalize(st(row("r", [B, T("A-1")], [3, 1])))).root)).toBe("row[board 0.75, A-1 0.25]");
  });

  test("nulls a focus or zoom on something that isn't a leaf", () => {
    const s = normalize(st(row("r", [B, T("A-1")]), "r", "missing"));
    expect(s.focusedId).toBeNull();
    expect(s.zoomedId).toBeNull();
    expect(normalize(st(row("r", [B, T("A-1")]), "A-1", "A-1")).zoomedId).toBe("A-1");
  });
});

describe("openTicket (the click-a-card rule)", () => {
  test("with only the board, splits it: board 60%, ticket 40% on the right, focused", () => {
    const s = valid(openTicket(defaultPanes(), "A-1"));
    expect(shape(s.root)).toBe("row[board 0.6, A-1 0.4]");
    expect(focusedLabel(s)).toBe("A-1");
    expect((ticketLeafByKey(s.root, "A-1")!.content as { tab: string }).tab).toBe("summaries");
  });

  test("replaces the ticket pane on the board's right, keeping the pane and its size", () => {
    const s = valid(openTicket(st(row("r", [B, T("A-1")], [0.7, 0.3])), "A-2", "transcript"));
    expect(shape(s.root)).toBe("row[board 0.7, A-2 0.3]");
    expect(s.focusedId).toBe("A-1"); // same pane id, new content
    expect(findLeaf(s.root, "A-1")!.content).toEqual(ticketContent("A-2", "transcript"));
  });

  test("with tickets stacked on the right, replaces the top one", () => {
    const s = valid(openTicket(st(row("r", [B, col("c", [T("A-1"), T("A-2")])])), "A-3"));
    expect(shape(s.root)).toBe("row[board 0.5, col[A-3 0.5, A-2 0.5] 0.5]");
  });

  test("only looks at the pane right after the board, not further right", () => {
    const s = valid(openTicket(st(row("r", [B, T("A-1"), T("A-2")])), "A-3"));
    expect(shape(s.root)).toBe(`row[board ${r(1 / 3)}, A-3 ${r(1 / 3)}, A-2 ${r(1 / 3)}]`);
  });

  test("walks up past a column to find the row where the board has a right neighbour", () => {
    // Board stacked over A-1 on the left, A-2 on the right: A-2 (right of the board's column) is replaced, not A-1.
    const s = valid(openTicket(st(row("r", [col("c", [B, T("A-1")]), T("A-2")])), "A-3"));
    expect(shape(s.root)).toBe("row[col[board 0.5, A-1 0.5] 0.5, A-3 0.5]");
    expect(s.focusedId).toBe("A-2");
  });

  test("when the board is right of a ticket, opens a new pane to the board's right from the board's share", () => {
    const s = valid(openTicket(st(row("r", [T("A-1"), B], [0.4, 0.6])), "A-2"));
    expect(shape(s.root)).toBe("row[A-1 0.4, board 0.36, A-2 0.24]");
  });

  test("when the board only has a pane below it, wraps the board in a row", () => {
    const s = valid(openTicket(st(col("c", [B, T("A-1")])), "A-2"));
    expect(shape(s.root)).toBe("col[row[board 0.6, A-2 0.4] 0.5, A-1 0.5]");
  });

  test("an already-open ticket is focused, not duplicated, and a given tab is applied", () => {
    const start = st(row("r", [B, T("A-1"), T("A-2")]), "B");
    const s = valid(openTicket(start, "A-2", "transcript"));
    expect(shape(s.root)).toBe(shape(start.root));
    expect(s.focusedId).toBe("A-2");
    expect(findLeaf(s.root, "A-2")!.content).toEqual(ticketContent("A-2", "transcript"));
    // No tab: the pane keeps its current tab.
    expect(findLeaf(openTicket(s, "A-2").root, "A-2")!.content).toEqual(ticketContent("A-2", "transcript"));
  });

  test("ends a zoom on another pane, keeps a zoom on the opened one", () => {
    expect(openTicket(st(row("r", [B, T("A-1")]), "B", "B"), "A-2").zoomedId).toBeNull();
    expect(openTicket(st(row("r", [B, T("A-1")]), "B", "B"), "A-9").zoomedId).toBeNull();
    expect(openTicket(st(row("r", [B, T("A-1")]), "A-1", "A-1"), "A-1").zoomedId).toBe("A-1");
  });
});

describe("dropContent", () => {
  const base = () => st(row("r", [B, T("A-1")], [0.6, 0.4]));

  test("right/left into a row parent become siblings splitting the target's share", () => {
    expect(shape(valid(dropContent(base(), "A-1", "right", ticketContent("A-2"))).root)).toBe("row[board 0.6, A-1 0.2, A-2 0.2]");
    expect(shape(valid(dropContent(base(), "A-1", "left", ticketContent("A-2"))).root)).toBe("row[board 0.6, A-2 0.2, A-1 0.2]");
  });

  test("top/bottom into a row parent nest a column in the target's place", () => {
    expect(shape(valid(dropContent(base(), "A-1", "bottom", ticketContent("A-2"))).root)).toBe("row[board 0.6, col[A-1 0.5, A-2 0.5] 0.4]");
    expect(shape(valid(dropContent(base(), "A-1", "top", ticketContent("A-2"))).root)).toBe("row[board 0.6, col[A-2 0.5, A-1 0.5] 0.4]");
  });

  test("top/bottom into a column parent become siblings; left/right nest a row", () => {
    const stacked = st(row("r", [B, col("c", [T("A-1"), T("A-2")])], [0.6, 0.4]));
    expect(shape(valid(dropContent(stacked, "A-2", "top", ticketContent("A-3"))).root)).toBe("row[board 0.6, col[A-1 0.5, A-3 0.25, A-2 0.25] 0.4]");
    expect(shape(valid(dropContent(stacked, "A-1", "right", ticketContent("A-3"))).root)).toBe("row[board 0.6, col[row[A-1 0.5, A-3 0.5] 0.5, A-2 0.5] 0.4]");
  });

  test("dropping on the root leaf wraps it", () => {
    expect(shape(valid(dropContent(defaultPanes(), "p1", "top", ticketContent("A-1"))).root)).toBe("col[A-1 0.5, board 0.5]");
  });

  test("the new pane is focused and a zoom ends", () => {
    const s = valid(dropContent(st(row("r", [B, T("A-1")]), "B", "A-1"), "A-1", "bottom", ticketContent("A-2")));
    expect(focusedLabel(s)).toBe("A-2");
    expect(s.zoomedId).toBeNull();
  });

  test("an already-open ticket moves (keeping its pane id) and takes the dropped tab", () => {
    const start = st(row("r", [B, T("A-1"), T("A-2")], [0.5, 0.25, 0.25]));
    const s = valid(dropContent(start, "B", "bottom", ticketContent("A-2", "transcript")));
    // A-2's share went to A-1; the board's column holds it now.
    expect(shape(s.root)).toBe("row[col[board 0.5, A-2 0.5] 0.5, A-1 0.5]");
    expect(findLeaf(s.root, "A-2")!.content).toEqual(ticketContent("A-2", "transcript"));
    expect(s.focusedId).toBe("A-2");
  });

  test("dropping a pane's own ticket on itself changes nothing", () => {
    const start = base();
    expect(dropContent(start, "A-1", "left", ticketContent("A-1", "transcript"))).toBe(start);
  });

  test("dropping the board moves the one board rather than adding another", () => {
    const s = valid(dropContent(base(), "A-1", "right", { kind: "board" }));
    expect(shape(s.root)).toBe("row[A-1 0.5, board 0.5]");
  });

  test("an unknown target changes nothing", () => {
    const start = base();
    expect(dropContent(start, "nope", "left", ticketContent("A-2"))).toBe(start);
  });
});

describe("movePane", () => {
  test("re-docks a pane out of a stack, collapsing the stack", () => {
    const start = st(row("r", [B, col("c", [T("A-1"), T("A-2")])], [0.6, 0.4]));
    const s = valid(movePane(start, "A-2", "B", "left"));
    expect(shape(s.root)).toBe("row[A-2 0.3, board 0.3, A-1 0.4]");
    expect(s.focusedId).toBe("A-2");
  });

  test("moving a pane beside its own sibling in the same split", () => {
    const s = valid(movePane(st(row("r", [B, T("A-1"), T("A-2")], [0.5, 0.25, 0.25])), "A-2", "A-1", "left"));
    expect(shape(s.root)).toBe("row[board 0.5, A-2 0.25, A-1 0.25]");
  });

  test("the board can be moved, and moving onto itself or an unknown pane is a no-op", () => {
    const start = st(row("r", [B, T("A-1")]));
    expect(shape(valid(movePane(start, "B", "A-1", "bottom")).root)).toBe("col[A-1 0.5, board 0.5]");
    expect(movePane(start, "A-1", "A-1", "left")).toBe(start);
    expect(movePane(start, "nope", "A-1", "left")).toBe(start);
    expect(movePane(start, "A-1", "nope", "left")).toBe(start);
  });
});

describe("closePane", () => {
  test("the board can't be closed", () => {
    const start = st(row("r", [B, T("A-1")]));
    expect(closePane(start, "B")).toBe(start);
    expect(closePane(start, "nope")).toBe(start);
  });

  test("a middle pane's share is split between its neighbours; an edge pane's goes to the one neighbour", () => {
    const start = st(row("r", [B, T("A-1"), T("A-2")], [0.5, 0.2, 0.3]));
    expect(shape(valid(closePane(start, "A-1")).root)).toBe("row[board 0.6, A-2 0.4]");
    expect(shape(valid(closePane(start, "A-2")).root)).toBe("row[board 0.5, A-1 0.5]");
  });

  test("closing the last ticket leaves just the board", () => {
    expect(shape(valid(closePane(st(row("r", [B, T("A-1")]), "A-1"), "A-1")).root)).toBe("board");
  });

  test("collapsing a stack flattens it into a same-dir parent, redistributing sizes", () => {
    // row[board, col[A-1, row[A-2, A-3]]]: closing A-1 leaves the inner row inside the outer row.
    const start = st(row("r", [B, col("c", [T("A-1"), row("r2", [T("A-2"), T("A-3")], [0.25, 0.75])])], [0.6, 0.4]));
    const s = valid(closePane(start, "A-1"));
    expect(shape(s.root)).toBe("row[board 0.6, A-2 0.1, A-3 0.3]");
  });

  test("focus moves to the nearest leaf of the pane that takes its place", () => {
    const start = (focus: string) => st(row("r", [B, T("A-1"), col("c", [T("A-2"), T("A-3")])]), focus);
    expect(focusedLabel(closePane(start("A-1"), "A-1"))).toBe("A-2"); // next sibling's first leaf
    const last = st(row("r", [col("c", [B, T("A-1")]), T("A-2")]), "A-2");
    expect(focusedLabel(closePane(last, "A-2"))).toBe("A-1"); // previous sibling's last leaf
  });

  test("closing an unfocused pane keeps the focus; closing the zoomed pane ends the zoom", () => {
    const start = st(row("r", [B, T("A-1"), T("A-2")]), "A-2", "A-1");
    const s = closePane(start, "A-1");
    expect(s.focusedId).toBe("A-2");
    expect(s.zoomedId).toBeNull();
    expect(closePane(st(row("r", [B, T("A-1"), T("A-2")]), null, "A-2"), "A-1").zoomedId).toBe("A-2");
  });
});

describe("setTab / replaceContent / focusPane / toggleZoom", () => {
  const start = () => st(row("r", [B, T("A-1"), T("A-2")]), "B");

  test("setTab changes a ticket pane's tab; the board and unknown ids are no-ops", () => {
    expect(findLeaf(setTab(start(), "A-1", "transcript").root, "A-1")!.content).toEqual(ticketContent("A-1", "transcript"));
    const s = start();
    expect(setTab(s, "B", "transcript")).toBe(s);
    expect(setTab(s, "nope", "transcript")).toBe(s);
    expect(setTab(s, "A-1", "summaries")).toBe(s);
  });

  test("replaceContent navigates a pane in place and focuses it", () => {
    const s = valid(replaceContent(start(), "A-1", ticketContent("A-9")));
    expect(shape(s.root)).toBe(`row[board ${r(1 / 3)}, A-9 ${r(1 / 3)}, A-2 ${r(1 / 3)}]`);
    expect(s.focusedId).toBe("A-1");
  });

  test("replaceContent focuses a ticket already open elsewhere instead of duplicating it", () => {
    const s = valid(replaceContent(start(), "A-1", ticketContent("A-2", "transcript")));
    expect(findLeaf(s.root, "A-1")!.content).toEqual(ticketContent("A-1"));
    expect(findLeaf(s.root, "A-2")!.content).toEqual(ticketContent("A-2", "transcript"));
    expect(s.focusedId).toBe("A-2");
  });

  test("replaceContent never navigates the board pane away, and board content focuses the board", () => {
    const s = start();
    expect(replaceContent(s, "B", ticketContent("A-9"))).toBe(s);
    const b = valid(replaceContent({ ...s, focusedId: "A-1" }, "A-1", { kind: "board" }));
    expect(b.focusedId).toBe("B");
    expect(findLeaf(b.root, "A-1")!.content).toEqual(ticketContent("A-1"));
  });

  test("focusPane focuses a leaf, ends a zoom on another, and ignores unknown ids", () => {
    expect(focusPane(start(), "A-2").focusedId).toBe("A-2");
    expect(focusPane({ ...start(), zoomedId: "A-1" }, "A-2").zoomedId).toBeNull();
    expect(focusPane({ ...start(), zoomedId: "A-1" }, "A-1").zoomedId).toBe("A-1");
    const s = start();
    expect(focusPane(s, "r")).toBe(s);
    expect(focusPane(s, "B")).toBe(s);
  });

  test("toggleZoom zooms (and focuses) then unzooms; defaults to the focused pane", () => {
    const z = toggleZoom(start(), "A-1");
    expect(z.zoomedId).toBe("A-1");
    expect(z.focusedId).toBe("A-1");
    expect(toggleZoom(z).zoomedId).toBeNull();
    expect(toggleZoom(start()).zoomedId).toBe("B");
  });

  test("toggleZoom switches zoom to another pane, and does nothing with one pane, no focus, or a split id", () => {
    expect(toggleZoom({ ...start(), zoomedId: "A-1" }, "A-2").zoomedId).toBe("A-2");
    const lone = { ...defaultPanes(), focusedId: "p1" };
    expect(toggleZoom(lone)).toBe(lone);
    const unfocused = { ...start(), focusedId: null };
    expect(toggleZoom(unfocused)).toBe(unfocused);
    const s = start();
    expect(toggleZoom(s, "r")).toBe(s);
  });
});

describe("setSizes", () => {
  test("commits normalized sizes to a split; a wrong count or a leaf id is ignored", () => {
    const start = st(row("r", [B, col("c", [T("A-1"), T("A-2")])]));
    expect(shape(valid(setSizes(start, "c", [3, 1])).root)).toBe("row[board 0.5, col[A-1 0.75, A-2 0.25] 0.5]");
    expect(setSizes(start, "c", [1])).toBe(start);
    expect(setSizes(start, "B", [1, 1])).toBe(start);
    expect(shape(valid(setSizes(start, "r", [0.7, 0.3])).root)).toBe("row[board 0.7, col[A-1 0.5, A-2 0.5] 0.3]");
  });
});

describe("resizeSplit", () => {
  test("moves only the divider's two neighbours", () => {
    expect(resizeSplit([0.5, 0.25, 0.25], 1, 100, 1000, 50).map(r)).toEqual([0.5, 0.35, 0.15]);
    expect(resizeSplit([0.5, 0.5], 0, -100, 1000, 50).map(r)).toEqual([0.4, 0.6]);
  });

  test("clamps each side at the minimum", () => {
    expect(resizeSplit([0.5, 0.5], 0, 10_000, 1000, 100).map(r)).toEqual([0.9, 0.1]);
    expect(resizeSplit([0.5, 0.5], 0, -10_000, 1000, 100).map(r)).toEqual([0.1, 0.9]);
  });

  test("when the pair can't fit two minimums, they share it equally", () => {
    expect(resizeSplit([0.8, 0.1, 0.1], 1, 30, 1000, 150).map(r)).toEqual([0.8, 0.1, 0.1]);
    expect(resizeSplit([0.8, 0.15, 0.05], 1, -50, 1000, 150).map(r)).toEqual([0.8, 0.1, 0.1]);
  });

  test("a bad index or size leaves the sizes alone", () => {
    expect(resizeSplit([0.5, 0.5], 1, 10, 1000, 10)).toEqual([0.5, 0.5]);
    expect(resizeSplit([0.5, 0.5], -1, 10, 1000, 10)).toEqual([0.5, 0.5]);
    expect(resizeSplit([0.5, 0.5], 0, 10, 0, 10)).toEqual([0.5, 0.5]);
    expect(resizeSplit([0.5, 0.5], 0, NaN, 1000, 10)).toEqual([0.5, 0.5]);
  });
});

describe("keySplit", () => {
  test("arrows along the split's axis step 16px (64px with Shift)", () => {
    expect(keySplit("ArrowRight", false, "row", [0.5, 0.5], 0, 1000, 50)!.map(r)).toEqual([0.516, 0.484]);
    expect(keySplit("ArrowLeft", true, "row", [0.5, 0.5], 0, 1000, 50)!.map(r)).toEqual([0.436, 0.564]);
    expect(keySplit("ArrowDown", false, "column", [0.5, 0.5], 0, 1000, 50)!.map(r)).toEqual([0.516, 0.484]);
    expect(keySplit("ArrowUp", false, "column", [0.5, 0.5], 0, 1000, 50)!.map(r)).toEqual([0.484, 0.516]);
  });

  test("Home/End go as far as the minimum allows", () => {
    expect(keySplit("Home", false, "row", [0.5, 0.5], 0, 1000, 100)!.map(r)).toEqual([0.1, 0.9]);
    expect(keySplit("End", false, "column", [0.5, 0.5], 0, 1000, 100)!.map(r)).toEqual([0.9, 0.1]);
  });

  test("cross-axis arrows and other keys aren't resize keys", () => {
    expect(keySplit("ArrowUp", false, "row", [0.5, 0.5], 0, 1000, 50)).toBeNull();
    expect(keySplit("ArrowLeft", false, "column", [0.5, 0.5], 0, 1000, 50)).toBeNull();
    expect(keySplit("a", false, "row", [0.5, 0.5], 0, 1000, 50)).toBeNull();
  });
});

describe("renameTicketKey / pruneTickets", () => {
  test("a renamed key follows into the same pane, keeping its tab", () => {
    const s = renameTicketKey(st(row("r", [B, T("A-1", "transcript")])), "A-1", "Z-1");
    expect(findLeaf(s.root, "A-1")!.content).toEqual(ticketContent("Z-1", "transcript"));
    expect(ticketLeafByKey(s.root, "A-1")).toBeNull();
  });

  test("if the new key is already open, the old pane closes and focus follows to the open one", () => {
    const s = valid(renameTicketKey(st(row("r", [B, T("A-1"), T("Z-1")]), "A-1"), "A-1", "Z-1"));
    expect(shape(s.root)).toBe("row[board 0.5, Z-1 0.5]");
    expect(focusedLabel(s)).toBe("Z-1");
  });

  test("an unknown or unchanged key is a no-op", () => {
    const start = st(row("r", [B, T("A-1")]));
    expect(renameTicketKey(start, "Q-1", "Z-1")).toBe(start);
    expect(renameTicketKey(start, "A-1", "A-1")).toBe(start);
  });

  test("pruneTickets closes panes for missing tickets and returns the same state when nothing is missing", () => {
    const start = st(row("r", [B, T("A-1"), col("c", [T("A-2"), T("A-3")])]), "A-2");
    const s = valid(pruneTickets(start, (k) => k === "A-3"));
    expect(shape(s.root)).toBe("row[board 0.5, A-3 0.5]");
    expect(focusedLabel(s)).toBe("A-3");
    expect(pruneTickets(start, () => true)).toBe(start);
  });
});

describe("parsePanes / serializePanes", () => {
  test("round-trips a state", () => {
    const s = valid(dropContent(openTicket(defaultPanes(), "A-1", "transcript"), "p1", "bottom", ticketContent("A-2")));
    const back = parsePanes(serializePanes(s));
    expect(back).toEqual(s);
  });

  test("missing, corrupt, or non-object data falls back to the default", () => {
    for (const raw of [null, undefined, "", "{", "null", "[]", "42", '"x"', "{}", '{"root":7}', '{"root":{"type":"split","dir":"row","children":[]}}']) {
      expect(shape(valid(parsePanes(raw)).root)).toBe("board");
    }
  });

  test("drops invalid leaves and unknown content kinds, re-normalizing what's left", () => {
    const raw = JSON.stringify({
      root: {
        type: "split",
        id: "r",
        dir: "row",
        sizes: [0.5, 0.2, 0.2, 0.1],
        children: [
          { type: "leaf", id: "B", content: { kind: "board" } },
          { type: "leaf", id: "t", content: { kind: "terminal", cwd: "/" } },
          { type: "leaf", id: "k", content: { kind: "ticket" } },
          { type: "leaf", id: "A", content: { kind: "ticket", ticketKey: "A-1", tab: "bogus" } },
        ],
      },
      focusedId: "t",
      zoomedId: 12,
    });
    const s = valid(parsePanes(raw));
    expect(shape(s.root)).toBe(`row[board ${r(0.5 / 0.6)}, A-1 ${r(0.1 / 0.6)}]`);
    expect(findLeaf(s.root, "A")!.content).toEqual(ticketContent("A-1")); // bad tab → summaries
    expect(s.focusedId).toBeNull();
    expect(s.zoomedId).toBeNull();
  });

  test("repairs trees that break invariants: two boards, duplicate keys, bad sizes, nesting", () => {
    const raw = JSON.stringify({
      root: row("r", [B, { ...B, id: "B2" }, T("A-1"), { ...T("A-1"), id: "A-1b" }, row("r2", [T("A-2"), col("c", [T("A-3")], [1])], ["x", 1] as unknown as number[])], [1, 1, 1, 1, "big"] as unknown as number[]),
      focusedId: "A-1b",
      zoomedId: "A-1",
    });
    const s = valid(parsePanes(raw));
    expect(shape(s.root)).toBe("row[board 0.333, A-1 0.333, A-2 0.167, A-3 0.167]");
    expect(s.focusedId).toBeNull();
    expect(s.zoomedId).toBe("A-1");
  });

  test("a stored tree without a board gets one back", () => {
    const s = valid(parsePanes(JSON.stringify({ root: T("A-1") })));
    expect(shape(s.root)).toBe("row[board 0.6, A-1 0.4]");
  });

  test("absurdly deep nesting is cut off rather than recursed forever", () => {
    let node: unknown = B;
    for (let i = 0; i < 100; i++) node = { type: "split", id: `s${i}`, dir: i % 2 ? "row" : "column", children: [node, T(`A-${i}`)], sizes: [0.5, 0.5] };
    const s = valid(parsePanes(JSON.stringify({ root: node })));
    expect(leaves(s.root).length).toBeLessThan(40);
  });
});

describe("ids", () => {
  test("new panes never reuse an id already in the tree", () => {
    // A stored tree already holds p1..p3; the counter starts over after a reload.
    const s = parsePanes(JSON.stringify({ root: row("p1", [{ ...B, id: "p2" }, T("A-1")].map((l, i) => (i ? { ...l, id: "p3" } : l))) }));
    const next = valid(dropContent(openTicket(s, "A-2"), "p2", "bottom", ticketContent("A-3")));
    expect(new Set(leaves(next.root).map((l) => l.id)).size).toBe(leaves(next.root).length);
  });
});
