import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyDrop,
  boardLeaf,
  checkPanes,
  closePane,
  defaultPanes,
  dropContent,
  dropPreview,
  dropTargetAt,
  findLeaf,
  focusedTicket,
  focusPane,
  keySplit,
  layoutPanes,
  leaves,
  minSize,
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
  splitTarget,
  ticketLeafByKey,
  toggleZoom,
  zoneAt,
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

  test("dropping on the root leaf wraps it, the board keeping its 60%", () => {
    expect(shape(valid(dropContent(defaultPanes(), "p1", "top", ticketContent("A-1"))).root)).toBe("col[A-1 0.4, board 0.6]");
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
    expect(shape(s.root)).toBe("row[col[board 0.6, A-2 0.4] 0.5, A-1 0.5]");
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
    expect(shape(s.root)).toBe("row[A-2 0.24, board 0.36, A-1 0.4]");
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

  test("each side can have its own minimum", () => {
    // Board (≥320) | ticket (≥360) in 1000px: the ticket can grow to 680, the board to 640.
    expect(resizeSplit([0.6, 0.4], 0, -10_000, 1000, [320, 360]).map(r)).toEqual([0.32, 0.68]);
    expect(resizeSplit([0.6, 0.4], 0, 10_000, 1000, [320, 360]).map(r)).toEqual([0.64, 0.36]);
    // Too small for both: shared in proportion to the minimums (100:300 of 400px).
    expect(resizeSplit([0.2, 0.2, 0.6], 0, 50, 1000, [100, 300]).map(r)).toEqual([0.1, 0.3, 0.6]);
  });
});

describe("minSize", () => {
  test("leaves need their own minimum; splits add along the axis and take the largest across it", () => {
    expect(minSize(B, "row")).toBe(320);
    expect(minSize(T("A"), "row")).toBe(360);
    expect(minSize(T("A"), "column")).toBe(200);
    const tree = split("row", "r", [B, split("column", "c", [T("A"), T("C"), T("D")])]);
    expect(minSize(tree, "row")).toBe(320 + 360);
    expect(minSize(tree, "column")).toBe(600);
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

describe("focusedTicket", () => {
  test("is the focused ticket pane's key and tab, or null for the board or no focus", () => {
    const root = split("row", "r", [B, T("A", "transcript")]);
    expect(focusedTicket({ root, focusedId: "A", zoomedId: null })).toEqual({ ticketKey: "A", tab: "transcript" });
    expect(focusedTicket({ root, focusedId: "B", zoomedId: null })).toBeNull();
    expect(focusedTicket({ root, focusedId: null, zoomedId: null })).toBeNull();
  });
});

describe("layoutPanes", () => {
  const rr = (x: { x: number; y: number; w: number; h: number }) => [r(x.x), r(x.y), r(x.w), r(x.h)];
  // B | (A over C), 60/40, the column 25/75.
  const state: PaneState = { root: split("row", "r", [B, split("column", "c", [T("A"), T("C")], [0.25, 0.75])], [0.6, 0.4]), focusedId: null, zoomedId: null };

  test("places nested panes as fractions of the whole area, in tree order", () => {
    const l = layoutPanes(state);
    expect(l.leaves.map((b) => [b.leaf.id, ...rr(b.rect)])).toEqual([
      ["B", 0, 0, 0.6, 1],
      ["A", 0.6, 0, 0.4, 0.25],
      ["C", 0.6, 0.25, 0.4, 0.75],
    ]);
    expect(l.leaves.every((b) => !b.hidden)).toBe(true);
  });

  test("puts a divider on each boundary, spanning its split", () => {
    const l = layoutPanes(state);
    expect(l.dividers.map((d) => [d.split.id, d.index, r(d.at), ...rr(d.rect)])).toEqual([
      ["r", 0, 0.6, 0, 0, 1, 1],
      ["c", 0, 0.25, 0.6, 0, 0.4, 1],
    ]);
  });

  test("the corner pane is the first leaf, even when the board isn't on the left", () => {
    expect(layoutPanes(state).cornerId).toBe("B");
    expect(layoutPanes({ ...state, root: split("column", "c", [T("A"), B]) }).cornerId).toBe("A");
  });

  test("a zoomed pane fills the area, hides the others and has no dividers", () => {
    const l = layoutPanes({ ...state, focusedId: "C", zoomedId: "C" });
    expect(l.leaves.map((b) => [b.leaf.id, b.hidden])).toEqual([["B", true], ["A", true], ["C", false]]);
    expect(rr(l.leaves[2]!.rect)).toEqual([0, 0, 1, 1]);
    expect(l.dividers).toEqual([]);
    expect(l.cornerId).toBe("C");
  });
});

describe("zoneAt", () => {
  const box = { x: 100, y: 50, w: 400, h: 200 };

  test("each edge's triangle is its zone, in the rect's own proportions", () => {
    expect(zoneAt(box, 490, 150)).toBe("right");
    expect(zoneAt(box, 110, 150)).toBe("left");
    expect(zoneAt(box, 300, 60)).toBe("top");
    expect(zoneAt(box, 300, 240)).toBe("bottom");
    // A wide pane: 40% across and 10% down is nearer the top than the left edge.
    expect(zoneAt(box, 260, 70)).toBe("top");
    // …and 10% across, 40% down is nearer the left.
    expect(zoneAt(box, 140, 130)).toBe("left");
  });

  test("just either side of a diagonal", () => {
    // The top-left diagonal runs through (100 + 400t, 50 + 200t); t = 0.25 → (200, 100).
    expect(zoneAt(box, 201, 100)).toBe("top");
    expect(zoneAt(box, 199, 100)).toBe("left");
    expect(zoneAt(box, 200, 101)).toBe("left");
    expect(zoneAt(box, 200, 99)).toBe("top");
    // Bottom-right diagonal at t = 0.75 → (400, 200).
    expect(zoneAt(box, 399, 200)).toBe("bottom");
    expect(zoneAt(box, 401, 200)).toBe("right");
  });

  test("points exactly on a diagonal split side by side; the centre goes right", () => {
    expect(zoneAt(box, 200, 100)).toBe("left"); // top-left diagonal
    expect(zoneAt(box, 400, 100)).toBe("right"); // top-right diagonal
    expect(zoneAt(box, 200, 200)).toBe("left"); // bottom-left diagonal
    expect(zoneAt(box, 400, 200)).toBe("right"); // bottom-right diagonal
    expect(zoneAt(box, 300, 150)).toBe("right");
  });

  test("edges and corners are inside; anything past them is outside", () => {
    expect(zoneAt(box, 100, 150)).toBe("left");
    expect(zoneAt(box, 500, 150)).toBe("right");
    expect(zoneAt(box, 300, 50)).toBe("top");
    expect(zoneAt(box, 300, 250)).toBe("bottom");
    expect(zoneAt(box, 100, 50)).toBe("left"); // a corner is on both a diagonal and two edges
    expect(zoneAt(box, 99.9, 150)).toBeNull();
    expect(zoneAt(box, 500.1, 150)).toBeNull();
    expect(zoneAt(box, 300, 49.9)).toBeNull();
    expect(zoneAt(box, 300, 250.1)).toBeNull();
  });

  test("an empty rect or a non-finite point has no zone", () => {
    expect(zoneAt({ x: 0, y: 0, w: 0, h: 100 }, 0, 50)).toBeNull();
    expect(zoneAt({ x: 0, y: 0, w: 100, h: 0 }, 50, 0)).toBeNull();
    expect(zoneAt(box, NaN, 150)).toBeNull();
  });
});

describe("dropPreview", () => {
  const rr = (v: { x: number; y: number; w: number; h: number } | null) => v && [r(v.x), r(v.y), r(v.w), r(v.h)];
  const three = st(row("r", [B, T("A-1"), T("A-2")], [0.5, 0.25, 0.25]));

  test("is where the new pane lands: 40% beside the board, half of a ticket pane", () => {
    expect(rr(dropPreview(st(B), { kind: "ticket", ticketKey: "A-1" }, "B", "right"))).toEqual([0.6, 0, 0.4, 1]);
    expect(rr(dropPreview(st(B), { kind: "ticket", ticketKey: "A-1" }, "B", "top"))).toEqual([0, 0, 1, 0.4]);
    expect(rr(dropPreview(three, { kind: "ticket", ticketKey: "A-9" }, "A-2", "bottom"))).toEqual([0.75, 0.5, 0.25, 0.5]);
    expect(rr(dropPreview(three, { kind: "ticket", ticketKey: "A-9" }, "A-1", "left"))).toEqual([0.5, 0, 0.125, 1]);
  });

  test("a moved pane's old space closes up first", () => {
    // A-2 leaves (A-1 takes its quarter), then splits A-1's half.
    expect(rr(dropPreview(three, { kind: "pane", leafId: "A-2" }, "A-1", "bottom"))).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  test("is null when the drop would do nothing", () => {
    expect(dropPreview(three, { kind: "pane", leafId: "A-1" }, "A-1", "left")).toBeNull();
    expect(dropPreview(three, { kind: "ticket", ticketKey: "A-2" }, "A-2", "top")).toBeNull();
  });
});

describe("dropTargetAt", () => {
  const state = st(row("r", [B, col("c", [T("A"), T("C")])], [0.6, 0.4]));

  test("finds the pane under the point and the half pointed at", () => {
    const l = layoutPanes(state);
    expect(dropTargetAt(l, 0.55, 0.5)).toMatchObject({ leafId: "B", zone: "right" });
    expect(dropTargetAt(l, 0.8, 0.45)).toMatchObject({ leafId: "A", zone: "bottom" });
    expect(dropTargetAt(l, 0.8, 0.55)).toMatchObject({ leafId: "C", zone: "top" });
    expect(dropTargetAt(l, 1.01, 0.5)).toBeNull();
  });

  test("skips panes hidden under a zoom", () => {
    const l = layoutPanes({ ...state, focusedId: "C", zoomedId: "C" });
    expect(dropTargetAt(l, 0.1, 0.5)).toMatchObject({ leafId: "C", zone: "left" });
  });
});

describe("applyDrop", () => {
  test("a card on the right half of the board opens beside it", () => {
    const s = valid(applyDrop(defaultPanes(), { kind: "ticket", ticketKey: "A-1" }, "p1", "right"));
    expect(shape(s.root)).toBe("row[board 0.6, A-1 0.4]");
    expect(focusedLabel(s)).toBe("A-1");
    // …the same split a click makes.
    expect(shape(openTicket(defaultPanes(), "A-1").root)).toBe(shape(s.root));
  });

  test("an open ticket's card moves its pane and keeps its tab", () => {
    const start = st(row("r", [B, T("A-1", "transcript"), T("A-2")], [0.5, 0.25, 0.25]));
    const s = valid(applyDrop(start, { kind: "ticket", ticketKey: "A-1" }, "A-2", "bottom"));
    expect(shape(s.root)).toBe("row[board 0.625, col[A-2 0.5, A-1 0.5] 0.375]");
    expect(findLeaf(s.root, "A-1")!.content).toEqual(ticketContent("A-1", "transcript"));
  });

  test("dropping a ticket or a pane on its own pane is a no-op (no preview)", () => {
    const start = st(row("r", [B, T("A-1")]));
    expect(applyDrop(start, { kind: "ticket", ticketKey: "A-1" }, "A-1", "left")).toBe(start);
    expect(applyDrop(start, { kind: "pane", leafId: "A-1" }, "A-1", "top")).toBe(start);
    expect(applyDrop(start, { kind: "pane", leafId: "gone" }, "B", "top")).toBe(start);
  });

  test("a pane dragged by its header re-docks", () => {
    const s = valid(applyDrop(st(row("r", [B, T("A-1"), T("A-2")], [0.5, 0.25, 0.25])), { kind: "pane", leafId: "A-2" }, "B", "top"));
    expect(shape(s.root)).toBe("row[col[A-2 0.4, board 0.6] 0.5, A-1 0.5]");
  });
});

describe("splitTarget", () => {
  const start = st(row("r", [B, T("A-1"), T("A-2")]), "A-2");

  test("the pane the command came from, else the focused pane, else the board", () => {
    expect(splitTarget(start, "A-1")).toBe("A-1");
    expect(splitTarget(start)).toBe("A-2");
    expect(splitTarget(start, "gone")).toBe("A-2");
    expect(splitTarget({ ...start, focusedId: null })).toBe("B");
    expect(splitTarget({ ...start, focusedId: "gone" })).toBe("B");
  });

  test("skips a pane already showing the ticket being opened", () => {
    expect(splitTarget(start, null, "A-2")).toBe("B");
    expect(splitTarget(start, "A-1", "A-1")).toBe("A-2");
    expect(splitTarget(start, "A-1", "A-9")).toBe("A-1");
  });
});
