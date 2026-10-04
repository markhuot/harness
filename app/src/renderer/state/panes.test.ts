import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ALL_SCOPE } from "@harness/shared/state";
import {
  applyDrop,
  boardLeaf,
  checkPanes,
  clampSizes,
  closedSessions,
  composeLeafById,
  composeToTicket,
  cwdName,
  closePane,
  defaultPanes,
  dropContent,
  dropPreview,
  dropTargetAt,
  equalizePanes,
  escapePanes,
  findLeaf,
  focusedTicket,
  focusPane,
  forgetProject,
  forgetProjectPanes,
  getPanes,
  keySplit,
  layoutPanes,
  leaves,
  mapScopes,
  minSize,
  movePane,
  newComposeContent,
  newTerminalContent,
  normalize,
  orphanSessions,
  openCompose,
  openFile,
  openTerminal,
  openTicket,
  openTicketInNewSplit,
  paneInDirection,
  paneLabel,
  PANE_MIN_WIDTH,
  PANES_KEY,
  parsePaneStore,
  parsePanes,
  pruneTickets,
  reloadPanes,
  renameTicketKey,
  replaceContent,
  resetPaneIds,
  resizeSplit,
  retainScopes,
  serializePaneStore,
  serializePanes,
  setFileView,
  setSizes,
  setTab,
  setTerminalTitle,
  splitTarget,
  terminalLeafBySession,
  terminalSessions,
  ticketLeafByKey,
  toggleZoom,
  updateAllPanes,
  updatePanes,
  watchPaneStore,
  zoneAt,
  dropInStore,
  popIn,
  popOut,
  popOutContent,
  popoutScope,
  popoutShowing,
  returnTab,
  setTornTab,
  tabContent,
  tornOffTabs,
  type DragSource,
  type TornTab,
  type FileContent,
  type PaneContent,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
  type PaneState,
  type PaneStore,
  type TerminalContent,
} from "./panes";

// Builders: leaf ids are the ticket key (or "B" for the board) so shapes and focus read naturally.
const B: PaneLeaf = { type: "leaf", id: "B", content: { kind: "board" } };
const T = (key: string, tab: "spec" | "transcript" = "spec"): PaneLeaf => ({ type: "leaf", id: key, content: { kind: "ticket", ticketKey: key, tab } });
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

const ticketContent = (key: string, tab: "spec" | "transcript" = "spec"): PaneContent => ({ kind: "ticket", ticketKey: key, tab });
const label = (l: PaneLeaf) =>
  l.content.kind === "board"
    ? "board"
    : l.content.kind === "ticket"
      ? l.content.ticketKey
      : l.content.kind === "compose"
        ? `+${l.content.id}`
        : l.content.kind === "file"
          ? `@${l.content.path}${l.content.startLine ? `:${l.content.startLine}${l.content.endLine ? `-${l.content.endLine}` : ""}` : ""}${l.content.tab === "diff" ? "(diff)" : ""}`
          : l.content.kind === "ticketTab"
            ? `${l.content.ticketKey}/${l.content.tab}${l.content.browserTab !== undefined ? `#${l.content.browserTab}` : ""}`
            : `$${l.content.sessionId}`;
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
    expect((ticketLeafByKey(s.root, "A-1")!.content as { tab: string }).tab).toBe("spec");
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

describe("openTicketInNewSplit (⇧⌘↩ on a card)", () => {
  test("opens a new pane right of the ticket pane beside the board, splitting its space", () => {
    const s = valid(openTicketInNewSplit(st(row("r", [B, T("A-1")], [0.6, 0.4]), "B"), "A-2"));
    expect(shape(s.root)).toBe("row[board 0.6, A-1 0.2, A-2 0.2]");
    expect(focusedLabel(s)).toBe("A-2");
    expect(s.focusedId).not.toBe("A-1");
  });

  test("splits the ticket pane openTicket would replace, not the last one in the row", () => {
    const s = valid(openTicketInNewSplit(st(row("r", [B, T("A-1"), T("A-2")], [0.5, 0.25, 0.25])), "A-3"));
    expect(shape(s.root)).toBe("row[board 0.5, A-1 0.125, A-3 0.125, A-2 0.25]");
  });

  test("with tickets stacked beside the board, splits the top one sideways", () => {
    const s = valid(openTicketInNewSplit(st(row("r", [B, col("c", [T("A-1"), T("A-2")])])), "A-3"));
    expect(shape(s.root)).toBe("row[board 0.5, col[row[A-1 0.5, A-3 0.5] 0.5, A-2 0.5] 0.5]");
  });

  test("with only the board, opens beside it as a click would", () => {
    const s = valid(openTicketInNewSplit(defaultPanes(), "A-1"));
    expect(shape(s.root)).toBe("row[board 0.6, A-1 0.4]");
    expect(focusedLabel(s)).toBe("A-1");
  });

  test("an already-open ticket is focused, not opened twice", () => {
    const start = st(row("r", [B, T("A-1"), T("A-2")]), "B");
    const s = valid(openTicketInNewSplit(start, "A-2"));
    expect(shape(s.root)).toBe(shape(start.root));
    expect(s.focusedId).toBe("A-2");
  });

  test("ends a zoom so the new pane is visible", () => {
    expect(openTicketInNewSplit(st(row("r", [B, T("A-1")]), "A-1", "A-1"), "A-2").zoomedId).toBeNull();
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
    expect(shape(s.root)).toBe("row[A-1 0.4, board 0.6]");
    expect(shape(valid(dropContent(base(), "A-1", "bottom", { kind: "board" })).root)).toBe("col[A-1 0.5, board 0.5]");
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

  test("a pane moved along its own split keeps its size, and so does every other pane", () => {
    const start = st(row("r", [B, T("A"), T("C")], [0.25, 0.5, 0.25]));
    const s = valid(movePane(start, "C", "A", "left"));
    expect(shape(s.root)).toBe("row[board 0.25, C 0.25, A 0.5]");
    expect(s.focusedId).toBe("C");
    expect(shape(valid(movePane(start, "C", "B", "left")).root)).toBe("row[C 0.25, board 0.25, A 0.5]");
    expect(shape(valid(movePane(start, "B", "C", "right")).root)).toBe("row[A 0.5, C 0.25, board 0.25]");
    // Stacked panes too.
    const stacked = st(row("r", [B, col("c", [T("A"), T("C"), T("D")], [0.2, 0.3, 0.5])], [0.5, 0.5]));
    expect(shape(valid(movePane(stacked, "D", "A", "top")).root)).toBe("row[board 0.5, col[D 0.5, A 0.2, C 0.3] 0.5]");
  });

  test("dropping a pane where it already is changes nothing (no preview)", () => {
    const start = st(row("r", [B, T("A"), T("C")], [0.25, 0.5, 0.25]));
    expect(movePane(start, "C", "A", "right")).toBe(start);
    expect(movePane(start, "A", "C", "left")).toBe(start);
    expect(applyDrop(start, { kind: "ticket", ticketKey: "C" }, "A", "right")).toBe(start);
  });

  test("a move across the split's axis, or into another split, splits the target's space evenly", () => {
    const start = st(row("r", [B, T("A"), T("C")], [0.25, 0.5, 0.25]));
    // C can't keep its width once it's stacked with A: A's column (with C's old share) is shared 50/50.
    expect(shape(valid(movePane(start, "C", "A", "bottom")).root)).toBe("row[board 0.25, col[A 0.5, C 0.5] 0.75]");
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
    expect(setTab(s, "A-1", "spec")).toBe(s);
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
  test("every pane on each side of the divider scales, keeping their proportions", () => {
    // Dragging the last divider 200px left: the last pane grows, the first two shrink alike (2:1).
    expect(resizeSplit([0.5, 0.25, 0.25], 1, -200, 1000, 50).map(r)).toEqual([0.367, 0.183, 0.45]);
    // Dragging the first divider right: the two after it shrink alike (1:1).
    expect(resizeSplit([0.5, 0.25, 0.25], 0, 100, 1000, 50).map(r)).toEqual([0.6, 0.2, 0.2]);
    expect(resizeSplit([0.5, 0.5], 0, -100, 1000, 50).map(r)).toEqual([0.4, 0.6]);
  });

  test("with pair (⌥) only the divider's two neighbours move", () => {
    expect(resizeSplit([0.5, 0.25, 0.25], 1, 100, 1000, 50, true).map(r)).toEqual([0.5, 0.35, 0.15]);
    expect(resizeSplit([0.5, 0.25, 0.25], 1, -200, 1000, 50, true).map(r)).toEqual([0.5, 0.05, 0.45]);
  });

  test("a pane that reaches its minimum stops there while the rest of its side keeps shrinking", () => {
    // [500, 400 (at its min), 100] with mins [300, 400, 100]: the last pane grows 200px, all taken from the first.
    expect(resizeSplit([0.5, 0.4, 0.1], 1, -200, 1000, [300, 400, 100]).map(r)).toEqual([0.3, 0.4, 0.3]);
    // …and the side can't shrink past the sum of its minimums.
    expect(resizeSplit([0.5, 0.4, 0.1], 1, -10_000, 1000, [300, 400, 100]).map(r)).toEqual([0.3, 0.4, 0.3]);
  });

  test("clamps each side at the minimum", () => {
    expect(resizeSplit([0.5, 0.5], 0, 10_000, 1000, 100).map(r)).toEqual([0.9, 0.1]);
    expect(resizeSplit([0.5, 0.5], 0, -10_000, 1000, 100).map(r)).toEqual([0.1, 0.9]);
    expect(resizeSplit([0.4, 0.3, 0.3], 0, 10_000, 1000, 100).map(r)).toEqual([0.8, 0.1, 0.1]);
  });

  test("when the pair can't fit two minimums, they share it equally", () => {
    expect(resizeSplit([0.8, 0.1, 0.1], 1, 30, 1000, 150, true).map(r)).toEqual([0.8, 0.1, 0.1]);
    expect(resizeSplit([0.8, 0.15, 0.05], 1, -50, 1000, 150, true).map(r)).toEqual([0.8, 0.1, 0.1]);
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
    expect(resizeSplit([0.2, 0.2, 0.6], 0, 50, 1000, [100, 300, 100], true).map(r)).toEqual([0.1, 0.3, 0.6]);
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

  test("the arrows scale each side's panes together; ⌥ (pair) moves only the two touching it", () => {
    expect(keySplit("ArrowLeft", true, "row", [0.5, 0.25, 0.25], 1, 1000, 50)!.map(r)).toEqual([0.457, 0.229, 0.314]);
    expect(keySplit("ArrowLeft", true, "row", [0.5, 0.25, 0.25], 1, 1000, 50, true)!.map(r)).toEqual([0.5, 0.186, 0.314]);
  });

  test("cross-axis arrows and other keys aren't resize keys", () => {
    expect(keySplit("ArrowUp", false, "row", [0.5, 0.5], 0, 1000, 50)).toBeNull();
    expect(keySplit("ArrowLeft", false, "column", [0.5, 0.5], 0, 1000, 50)).toBeNull();
    expect(keySplit("a", false, "row", [0.5, 0.5], 0, 1000, 50)).toBeNull();
  });
});

describe("equalizePanes", () => {
  test("siblings share the room evenly, nested splits included", () => {
    // Three panes side by side under the board, the last stacked in two.
    const start = st(col("top", [B, row("r", [T("A"), T("C"), col("c", [T("D"), T("E")], [0.8, 0.2])], [0.5, 0.3, 0.2])], [0.3, 0.7]));
    expect(shape(valid(equalizePanes(start)).root)).toBe("col[board 0.3, row[A 0.333, C 0.333, col[D 0.5, E 0.5] 0.333] 0.7]");
  });

  test("the board keeps its share and the other panes split what's left", () => {
    const start = st(row("r", [B, T("A"), T("C")], [0.25, 0.5, 0.25]));
    expect(shape(valid(equalizePanes(start)).root)).toBe("row[board 0.25, A 0.375, C 0.375]");
    // A split holding the board keeps its share too, and inside it the board keeps its own.
    const nested = st(row("r", [col("c", [B, T("A")], [0.7, 0.3]), T("C"), T("D")], [0.4, 0.1, 0.5]));
    expect(shape(valid(equalizePanes(nested)).root)).toBe("row[col[board 0.7, A 0.3] 0.4, C 0.3, D 0.3]");
  });

  test("already even (or just the board) is a no-op", () => {
    const even = st(row("r", [B, T("A"), T("C")], [0.4, 0.3, 0.3]));
    expect(equalizePanes(even)).toBe(even);
    const lone = defaultPanes();
    expect(equalizePanes(lone)).toBe(lone);
  });

  test("keeps focus and zoom", () => {
    const s = equalizePanes(st(row("r", [T("A"), T("C")], [0.9, 0.1]), "C", "C"));
    expect([s.focusedId, s.zoomedId]).toEqual(["C", "C"]);
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
          { type: "leaf", id: "t", content: { kind: "spreadsheet", cwd: "/" } },
          { type: "leaf", id: "k", content: { kind: "ticket" } },
          { type: "leaf", id: "A", content: { kind: "ticket", ticketKey: "A-1", tab: "bogus" } },
        ],
      },
      focusedId: "t",
      zoomedId: 12,
    });
    const s = valid(parsePanes(raw));
    expect(shape(s.root)).toBe(`row[board ${r(0.5 / 0.6)}, A-1 ${r(0.1 / 0.6)}]`);
    expect(findLeaf(s.root, "A")!.content).toEqual(ticketContent("A-1")); // bad tab → spec
    expect(s.focusedId).toBeNull();
    expect(s.zoomedId).toBeNull();
  });

  test("a pane saved on the old Summaries tab opens on the Spec, the git plugin's Changes on the built-in one; other tabs are kept", () => {
    const raw = JSON.stringify({
      root: {
        type: "split",
        id: "r",
        dir: "row",
        sizes: [0.4, 0.2, 0.2, 0.2],
        children: [
          B,
          { type: "leaf", id: "A", content: { kind: "ticket", ticketKey: "A-1", tab: "summaries" } },
          { type: "leaf", id: "C", content: { kind: "ticket", ticketKey: "A-2", tab: "activity" } },
          { type: "leaf", id: "D", content: { kind: "ticket", ticketKey: "A-3", tab: "plugin:git:changes" } },
        ],
      },
      focusedId: "A",
      zoomedId: null,
    });
    const s = valid(parsePanes(raw));
    expect(findLeaf(s.root, "A")!.content).toEqual({ kind: "ticket", ticketKey: "A-1", tab: "spec" });
    expect(findLeaf(s.root, "C")!.content).toEqual({ kind: "ticket", ticketKey: "A-2", tab: "activity" });
    // The git plugin's Changes tab is built in now.
    expect(findLeaf(s.root, "D")!.content).toEqual({ kind: "ticket", ticketKey: "A-3", tab: "changes" });
    expect(s.focusedId).toBe("A");
    // Saved again, it no longer says "summaries".
    expect(serializePanes(s)).not.toContain("summaries");
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

describe("per-scope store", () => {
  const allIdsOf = (store: PaneStore) => Object.values(store.scopes).flatMap((sc) => {
    const out: string[] = [];
    const walk = (n: PaneNode) => (out.push(n.id), n.type === "split" && n.children.forEach(walk));
    walk(sc.root);
    return out;
  });
  const keysOf = (s: PaneState) => leaves(s.root).flatMap((l) => (l.content.kind === "ticket" ? [l.content.ticketKey] : []));

  test("the single tree from before scopes becomes the All projects scope, focus and zoom included", () => {
    const old = JSON.stringify({ root: row("r", [B, T("A-1"), T("B-2")], [0.5, 0.25, 0.25]), focusedId: "B-2", zoomedId: "A-1" });
    const store = parsePaneStore(old);
    expect(Object.keys(store.scopes)).toEqual([ALL_SCOPE]);
    const s = valid(store.scopes[ALL_SCOPE]!);
    expect(shape(s.root)).toBe("row[board 0.5, A-1 0.25, B-2 0.25]");
    expect([s.focusedId, s.zoomedId]).toEqual(["B-2", "A-1"]);
  });

  test("round-trips every scope", () => {
    const store: PaneStore = { scopes: { [ALL_SCOPE]: valid(openTicket(defaultPanes(), "A-1", "transcript")), proj: valid(openTicket(defaultPanes(), "B-1")) } };
    expect(parsePaneStore(serializePaneStore(store))).toEqual(store);
  });

  test("junk anywhere drops just that scope; unusable data is no scopes at all", () => {
    const good = { root: row("r", [B, T("A-1")]) };
    const raw = JSON.stringify({ scopes: { a: good, b: 7, c: { root: 9 }, d: null, e: [], "": good, f: { root: { type: "leaf", content: { kind: "board" } } } } });
    const store = parsePaneStore(raw);
    expect(Object.keys(store.scopes).sort()).toEqual(["a", "f"]);
    expect(shape(valid(store.scopes.a!).root)).toBe("row[board 0.5, A-1 0.5]");
    valid(store.scopes.f!); // the id-less board got one
    for (const junk of [null, "", "{", "[]", "7", "{}", '{"scopes":[]}', '{"scopes":7}', '{"root":7}']) expect(parsePaneStore(junk)).toEqual({ scopes: {} });
  });

  test("ids are unique across scopes: a later scope reusing an id gets a new one", () => {
    const raw = JSON.stringify({ scopes: { a: { root: row("r", [B, T("A-1")]), focusedId: "A-1" }, b: { root: row("r", [B, T("A-1")]), focusedId: "A-1" } } });
    const store = parsePaneStore(raw);
    const ids = allIdsOf(store);
    expect(new Set(ids).size).toBe(ids.length);
    expect(leaves(store.scopes.a!.root).map((l) => l.id)).toEqual(["B", "A-1"]); // the first scope keeps its ids
    expect(store.scopes.b!.focusedId).toBeNull(); // focus named the renamed leaf
  });

  test("new panes in one scope never take an id another scope already uses", () => {
    // Scope a was saved with p1..p5; after a reload the id sequence starts over.
    const a = dropContent(openTicket(openTicket(defaultPanes(), "A-1"), "A-2"), "p1", "bottom", ticketContent("A-3"));
    const raw = serializePaneStore({ scopes: { a } });
    resetPaneIds();
    const store = parsePaneStore(raw);
    const b = openTicket(defaultPanes("b:b"), "B-1");
    const taken = new Set(allIdsOf(store));
    for (const l of leaves(b.root)) expect(taken.has(l.id)).toBe(false);
  });

  // Two tickets open side by side, with ids of its own (a leaf's id is the key plus a scope suffix).
  const two = (sc: string, ...keys: string[]): PaneState =>
    normalize(st(row(`r${sc}`, [{ ...B, id: `B${sc}` }, ...keys.map((k) => ({ ...T(k), id: `${k}${sc}` }))]), `${keys[0]}${sc}`));

  test("mapScopes applies prune and rename to every scope, and changes nothing when nothing applies", () => {
    const store: PaneStore = { scopes: { [ALL_SCOPE]: two("*", "A-1", "A-2"), a: two("a", "A-1"), b: two("b", "B-1") } };
    const pruned = mapScopes(store, (s) => pruneTickets(s, (k) => k !== "A-1"));
    expect(Object.values(pruned.scopes).map(keysOf)).toEqual([["A-2"], [], ["B-1"]]);
    Object.values(pruned.scopes).forEach(valid);
    expect(pruned.scopes.b).toBe(store.scopes.b!);
    const renamed = mapScopes(store, (s) => renameTicketKey(s, "A-1", "Z-1"));
    expect(Object.values(renamed.scopes).map(keysOf)).toEqual([["Z-1", "A-2"], ["Z-1"], ["B-1"]]);
    expect(mapScopes(store, (s) => pruneTickets(s, () => true))).toBe(store);
  });

  test("forgetProject drops the project's scope and closes its tickets elsewhere, not a project whose key merely starts the same", () => {
    const store: PaneStore = {
      scopes: {
        [ALL_SCOPE]: two("*", "A-1", "AB-1", "B-1"),
        pa: two("pa", "A-2"),
        pb: two("pb", "B-1"),
      },
    };
    const next = forgetProject(store, "pa", "A");
    expect(Object.keys(next.scopes)).toEqual([ALL_SCOPE, "pb"]);
    expect(keysOf(valid(next.scopes[ALL_SCOPE]!)).sort()).toEqual(["AB-1", "B-1"]);
    expect(next.scopes.pb).toBe(store.scopes.pb!);
    // Without a key (the project wasn't loaded) only the scope goes.
    expect(keysOf(forgetProject(store, "pa", null).scopes[ALL_SCOPE]!)).toEqual(keysOf(store.scopes[ALL_SCOPE]!));
    expect(forgetProject(store, "gone", null)).toBe(store);
  });

  test("retainScopes keeps what it's told to, returning the same store when nothing goes", () => {
    const store: PaneStore = { scopes: { [ALL_SCOPE]: defaultPanes(), a: defaultPanes(), b: defaultPanes() } };
    expect(Object.keys(retainScopes(store, (s) => s !== "a").scopes)).toEqual([ALL_SCOPE, "b"]);
    expect(retainScopes(store, () => true)).toBe(store);
  });
});

describe("pane store (localStorage)", () => {
  const saved = (globalThis as { localStorage?: Storage }).localStorage;
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    reloadPanes();
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = saved;
    reloadPanes();
  });
  const keysOf = (s: PaneState) => leaves(s.root).flatMap((l) => (l.content.kind === "ticket" ? [l.content.ticketKey] : []));

  test("an operation in one scope leaves the others as they were, and survives a reload", () => {
    const b = getPanes("b");
    updatePanes("a", (s) => openTicket(s, "A-1"));
    expect(keysOf(getPanes("a"))).toEqual(["A-1"]);
    expect(getPanes("b")).toBe(b);
    expect(getPanes(ALL_SCOPE).root.type).toBe("leaf");
    reloadPanes();
    expect(keysOf(getPanes("a"))).toEqual(["A-1"]);
  });

  test("a board that was never stored keeps its pane id when another window's write is re-read", () => {
    const id = getPanes("b").root.id;
    reloadPanes(); // nothing stored: b is made up again
    expect(getPanes("b").root.id).toBe(id);
  });

  test("a no-op writes nothing", () => {
    updatePanes("a", (s) => s);
    updateAllPanes((s) => pruneTickets(s, () => true));
    expect(data.has(PANES_KEY)).toBe(false);
  });

  test("updateAllPanes and forgetProjectPanes reach scopes that aren't on screen", () => {
    updatePanes(ALL_SCOPE, (s) => openTicket(s, "A-1"));
    updatePanes("pa", (s) => openTicket(s, "A-2"));
    updatePanes("pb", (s) => openTicket(s, "A-1"));
    updateAllPanes((s) => renameTicketKey(s, "A-1", "A-9"));
    expect([keysOf(getPanes(ALL_SCOPE)), keysOf(getPanes("pb"))]).toEqual([["A-9"], ["A-9"]]);
    forgetProjectPanes("pa", "A");
    const stored = parsePaneStore(data.get(PANES_KEY));
    expect(Object.keys(stored.scopes).sort()).toEqual([ALL_SCOPE, "pb"].sort());
    expect(keysOf(stored.scopes[ALL_SCOPE]!)).toEqual([]);
    expect(keysOf(getPanes("pa"))).toEqual([]); // a bare board again
  });

  test("an old single-tree value is read into All projects", () => {
    data.set(PANES_KEY, JSON.stringify({ root: row("r", [B, T("A-1")]), focusedId: "A-1", zoomedId: null }));
    reloadPanes();
    expect(focusedTicket(getPanes(ALL_SCOPE))?.ticketKey).toBe("A-1");
    expect(keysOf(getPanes("a"))).toEqual([]);
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

describe("clampSizes", () => {
  const rs = (v: number[]) => v.map(r);

  test("sizes that already fit come back unchanged", () => {
    expect(clampSizes([0.6, 0.4], [320, 360], 1200)).toEqual([0.6, 0.4]);
    // Exactly at a minimum is fine.
    expect(rs(clampSizes([0.3, 0.7], [300, 360], 1000))).toEqual([0.3, 0.7]);
  });

  test("a pane below its minimum is raised to it; the others give up the room in proportion", () => {
    // 1200px: 960 | 120 | 120 → the two tickets need 360 each, the board takes what's left.
    expect(rs(clampSizes([0.8, 0.1, 0.1], [320, 360, 360], 1200))).toEqual([0.4, 0.3, 0.3]);
    // Raising one can push another under its own minimum: repeated until none is short.
    expect(rs(clampSizes([0.5, 0.45, 0.05], [320, 360, 360], 1100))).toEqual([0.345, 0.327, 0.327]);
    // Just short of fitting leaves each pane exactly at its minimum.
    expect(rs(clampSizes([0.9, 0.1], [320, 360], 680))).toEqual([0.471, 0.529]);
  });

  test("when the minimums don't fit, the space is shared in proportion to them", () => {
    expect(rs(clampSizes([0.9, 0.1], [320, 360], 600))).toEqual([0.471, 0.529]);
  });

  test("a zero or unknown length (not measured yet) or mismatched mins leave the sizes alone", () => {
    expect(clampSizes([0.9, 0.1], [320, 360], 0)).toEqual([0.9, 0.1]);
    expect(clampSizes([0.9, 0.1], [320, 360], NaN)).toEqual([0.9, 0.1]);
    expect(clampSizes([0.9, 0.1], [320], 1000)).toEqual([0.9, 0.1]);
  });
});

describe("layoutPanes with the workspace size", () => {
  const rr = (v: { x: number; y: number; w: number; h: number }) => [r(v.x), r(v.y), r(v.w), r(v.h)];

  test("a stale stored layout never renders a pane below its minimum when there's room", () => {
    // Saved in a wide window with a sliver of a ticket pane, then shown 1000 × 800.
    const state = st(row("r", [B, col("c", [T("A"), T("C")], [0.9, 0.1])], [0.95, 0.05]));
    const l = layoutPanes(state, { width: 1000, height: 800 });
    const box = (id: string) => rr(l.leaves.find((b) => b.leaf.id === id)!.rect);
    expect(box("B")).toEqual([0, 0, 0.64, 1]);
    expect(box("A")).toEqual([0.64, 0, 0.36, 0.75]); // 600px tall: C keeps its 200
    expect(box("C")).toEqual([0.64, 0.75, 0.36, 0.25]);
    // The dividers sit on the clamped boundaries and carry the clamped sizes for dragging.
    expect(l.dividers.map((d) => [r(d.at), ...d.sizes.map(r)])).toEqual([
      [0.64, 0.64, 0.36],
      [0.75, 0.75, 0.25],
    ]);
    // The stored sizes aren't touched.
    expect(state.root.type === "split" && state.root.sizes).toEqual([0.95, 0.05]);
  });

  test("without a size (or when everything fits) the stored sizes are laid out as is", () => {
    const state = st(row("r", [B, T("A")], [0.6, 0.4]));
    expect(rr(layoutPanes(state).leaves[1]!.rect)).toEqual([0.6, 0, 0.4, 1]);
    expect(rr(layoutPanes(state, { width: 1400, height: 900 }).leaves[1]!.rect)).toEqual([0.6, 0, 0.4, 1]);
    expect(rr(layoutPanes(st(row("r", [B, T("A")], [0.95, 0.05]))).leaves[1]!.rect)).toEqual([0.95, 0, 0.05, 1]);
  });
});


// ---------------------------------------------------------------------------
// Terminal panes
// ---------------------------------------------------------------------------

const term = (sessionId: string, cwd = "/work", title?: string): TerminalContent => ({ kind: "terminal", sessionId, cwd, ...(title ? { title } : {}) });
/** A terminal leaf whose id is `$` + its session, like `label` prints it. */
const TT = (sessionId: string, cwd = "/work"): PaneLeaf => ({ type: "leaf", id: `$${sessionId}`, content: term(sessionId, cwd) });
const sessionsOf = (s: PaneState) => leaves(s.root).flatMap((l) => (l.content.kind === "terminal" ? [l.content.sessionId] : []));

describe("openTerminal", () => {
  test("splits the focused pane in half, on its right, and focuses the terminal", () => {
    const s = valid(openTerminal(st(row("r", [B, T("A-1")], [0.6, 0.4]), "A-1"), term("t:1")));
    expect(shape(s.root)).toBe("row[board 0.6, A-1 0.2, $t:1 0.2]");
    expect(focusedLabel(s)).toBe("$t:1");
  });

  test("with nothing focused it opens beside the board, which keeps 60%", () => {
    const s = valid(openTerminal(st(row("r", [B, T("A-1")], [0.6, 0.4])), term("t:1")));
    expect(shape(s.root)).toBe("row[board 0.36, $t:1 0.24, A-1 0.4]");
    expect(focusedLabel(s)).toBe("$t:1");
  });

  test("a focused pane that's gone falls back to the board", () => {
    const s = valid(openTerminal(st(B, "nope"), term("t:1")));
    expect(shape(s.root)).toBe("row[board 0.6, $t:1 0.4]");
  });

  test("every new terminal is another pane, each with its own session", () => {
    let s = defaultPanes();
    let n = 0;
    for (let i = 0; i < 3; i++) s = valid(openTerminal(s, newTerminalContent("~", () => `uuid-${++n}`)));
    expect(sessionsOf(s).sort()).toEqual(["t:uuid-1", "t:uuid-2", "t:uuid-3"]);
    expect(new Set(leaves(s.root).map((l) => l.id)).size).toBe(4);
  });

  test("a session that's already open is focused, not opened twice", () => {
    const s0 = st(row("r", [B, TT("t:1"), T("A-1")]), "A-1");
    const s = valid(openTerminal(s0, term("t:1")));
    expect(s.root).toBe(s0.root);
    expect(focusedLabel(s)).toBe("$t:1");
  });

  test("a zoom ends so the new terminal is visible", () => {
    const s = valid(openTerminal(st(row("r", [B, T("A-1")]), "A-1", "A-1"), term("t:1")));
    expect(s.zoomedId).toBeNull();
    expect(focusedLabel(s)).toBe("$t:1");
  });

  test("newTerminalContent mints t:<uuid> session ids, which the main process accepts", () => {
    const a = newTerminalContent("/p");
    const b = newTerminalContent("/p");
    expect(a.sessionId).not.toBe(b.sessionId);
    for (const id of [a.sessionId, b.sessionId]) expect(id).toMatch(/^t:[0-9a-f-]{36}$/);
    expect(a.cwd).toBe("/p");
  });
});

describe("terminal panes alongside the other operations", () => {
  test("normalize keeps each session once, like a ticket key", () => {
    const s = normalize(st(row("r", [B, TT("t:1"), { ...TT("t:1"), id: "dup" }, TT("t:2")])));
    expect(sessionsOf(valid(s))).toEqual(["t:1", "t:2"]);
    expect(checkPanes(st(row("r", [B, TT("t:1"), { ...TT("t:1"), id: "dup" }])))).toContain("terminal t:1 is open twice");
  });

  test("dropping an open terminal's content moves its pane instead of opening it twice", () => {
    const s = valid(dropContent(st(row("r", [B, TT("t:1"), T("A-1")])), "A-1", "bottom", term("t:1")));
    expect(shape(s.root)).toBe("row[board 0.5, col[A-1 0.5, $t:1 0.5] 0.5]");
  });

  test("moving a terminal pane keeps its session and leaf", () => {
    const s = valid(movePane(st(row("r", [B, TT("t:1"), T("A-1")])), "$t:1", "A-1", "right"));
    expect(terminalLeafBySession(s.root, "t:1")!.id).toBe("$t:1");
    // A move along its own row: every pane keeps its third.
    expect(shape(s.root)).toBe(`row[board ${r(1 / 3)}, A-1 ${r(1 / 3)}, $t:1 ${r(1 / 3)}]`);
  });

  test("Escape-style closing and ticket bookkeeping leave terminals alone", () => {
    const s0 = st(row("r", [B, TT("t:1"), T("A-1")]), "$t:1");
    expect(sessionsOf(pruneTickets(s0, () => false))).toEqual(["t:1"]);
    expect(renameTicketKey(s0, "A-1", "B-1").root).not.toBe(s0.root);
    expect(sessionsOf(renameTicketKey(s0, "A-1", "B-1"))).toEqual(["t:1"]);
    expect(focusedTicket(s0)).toBeNull(); // a focused terminal isn't a ticket for the URL
  });

  test("navigating a terminal pane to a ticket open elsewhere focuses that pane and keeps the terminal", () => {
    const s = valid(replaceContent(st(row("r", [B, TT("t:1"), T("A-1")]), "$t:1"), "$t:1", ticketContent("A-1")));
    expect(focusedLabel(s)).toBe("A-1");
    expect(sessionsOf(s)).toEqual(["t:1"]);
  });

  test("minSize counts a terminal's minimum width", () => {
    expect(minSize(TT("t:1"), "row")).toBe(PANE_MIN_WIDTH.terminal);
    expect(minSize(row("r", [B, TT("t:1")]), "row")).toBe(PANE_MIN_WIDTH.board + PANE_MIN_WIDTH.terminal);
    expect(minSize(col("c", [T("A-1"), TT("t:1")]), "row")).toBe(Math.max(PANE_MIN_WIDTH.ticket, PANE_MIN_WIDTH.terminal));
  });

  test("setTerminalTitle stores the shell's title, clears it when empty, and ignores other panes", () => {
    const s0 = st(row("r", [B, TT("t:1"), T("A-1")]));
    const s1 = setTerminalTitle(s0, "$t:1", "vim notes.md");
    expect(findLeaf(s1.root, "$t:1")!.content).toEqual(term("t:1", "/work", "vim notes.md"));
    expect(setTerminalTitle(s1, "$t:1", "vim notes.md")).toBe(s1);
    expect(findLeaf(setTerminalTitle(s1, "$t:1", "").root, "$t:1")!.content).toEqual(term("t:1"));
    expect(setTerminalTitle(s0, "A-1", "x")).toBe(s0);
    expect(setTerminalTitle(s0, "missing", "x")).toBe(s0);
  });
});

describe("terminal content in storage", () => {
  test("round-trips, title included", () => {
    const s0 = normalize(st(row("r", [B, { type: "leaf", id: "p9", content: term("t:abc", "~/code", "zsh") }]), "p9"));
    const s = valid(parsePanes(serializePanes(s0)));
    expect(findLeaf(s.root, "p9")!.content).toEqual(term("t:abc", "~/code", "zsh"));
    expect(s.focusedId).toBe("p9");
  });

  test("a terminal the main process couldn't attach to (bad session id, no folder) is dropped", () => {
    const bad = [
      { kind: "terminal", cwd: "/" },
      { kind: "terminal", sessionId: "", cwd: "/" },
      { kind: "terminal", sessionId: "t:has space", cwd: "/" },
      { kind: "terminal", sessionId: "t:" + "x".repeat(200), cwd: "/" },
      { kind: "terminal", sessionId: "t:1", cwd: 7 },
      { kind: "terminal", sessionId: "t:1", cwd: "" },
    ];
    const raw = JSON.stringify({ root: { type: "split", id: "r", dir: "row", children: [{ type: "leaf", id: "B", content: { kind: "board" } }, ...bad.map((content, i) => ({ type: "leaf", id: `x${i}`, content }))] } });
    expect(shape(valid(parsePanes(raw)).root)).toBe("board");
  });

  test("a non-string title is ignored, the terminal kept", () => {
    const raw = JSON.stringify({ root: { type: "split", id: "r", dir: "row", children: [{ type: "leaf", id: "B", content: { kind: "board" } }, { type: "leaf", id: "t", content: { kind: "terminal", sessionId: "t:1", cwd: "/", title: 5 } }] } });
    expect(findLeaf(parsePanes(raw).root, "t")!.content).toEqual(term("t:1", "/"));
  });

  test("a session stored in two scopes stays in the first; a pane re-id'd on load keeps its session", () => {
    const tree = (sessionId: string) => ({ root: { type: "split", id: "r", dir: "row", children: [{ type: "leaf", id: "B", content: { kind: "board" } }, { type: "leaf", id: "p1", content: term(sessionId) }] } });
    // Two windows minted p1 for different terminals (in a and b), and a third copy of t:1 in c.
    const store = parsePaneStore(JSON.stringify({ scopes: { a: tree("t:1"), b: tree("t:2"), c: tree("t:1") } }));
    expect(sessionsOf(store.scopes.a!)).toEqual(["t:1"]);
    expect(sessionsOf(store.scopes.b!)).toEqual(["t:2"]);
    expect(sessionsOf(store.scopes.c!)).toEqual([]);
    const bLeaf = terminalLeafBySession(store.scopes.b!.root, "t:2")!;
    expect(bLeaf.id).not.toBe("p1");
    expect(terminalSessions(store)).toEqual(new Set(["t:1", "t:2"]));
  });
});

describe("closedSessions (which shells to kill)", () => {
  const withTerms = (...ids: string[]) => normalize(st(ids.length ? row("r", [B, ...ids.map((id) => TT(id))]) : B));

  test("closing a terminal pane closes its session", () => {
    const before: PaneStore = { scopes: { a: withTerms("t:1", "t:2") } };
    const after = mapScopes(before, (s) => closePane(s, "$t:1"));
    expect(closedSessions(before, after)).toEqual(["t:1"]);
  });

  test("moving a pane, or a session showing up in another scope, kills nothing", () => {
    const before: PaneStore = { scopes: { a: withTerms("t:1", "t:2") } };
    expect(closedSessions(before, mapScopes(before, (s) => movePane(s, "$t:1", "$t:2", "bottom")))).toEqual([]);
    expect(closedSessions(before, { scopes: { a: withTerms("t:2"), b: withTerms("t:1") } })).toEqual([]);
    expect(closedSessions(before, before)).toEqual([]);
  });

  test("removing a project closes the terminals on its board, not the ones on All projects", () => {
    const before: PaneStore = { scopes: { [ALL_SCOPE]: withTerms("t:home"), p1: withTerms("t:1", "t:2") } };
    expect(closedSessions(before, forgetProject(before, "p1", "P")).sort()).toEqual(["t:1", "t:2"]);
    expect(closedSessions(before, retainScopes(before, (s) => s !== "p1")).sort()).toEqual(["t:1", "t:2"]);
  });
});

test("orphanSessions: pane shells no scope shows, never a shell with another kind of id", () => {
  const store: PaneStore = { scopes: { a: normalize(st(row("r", [B, TT("t:open")]))) } };
  expect(orphanSessions(["t:open", "t:gone", "t1", "debug"], store)).toEqual(["t:gone"]);
  expect(orphanSessions([], store)).toEqual([]);
});

describe("paneLabel / cwdName", () => {
  test("a terminal is named by its title, else its folder", () => {
    expect(paneLabel(term("t:1", "/Users/me/Sites/harness", "htop"))).toBe("htop");
    expect(paneLabel(term("t:1", "/Users/me/Sites/harness"))).toBe("harness");
    expect(paneLabel({ kind: "board" })).toBe("the board");
    expect(paneLabel(ticketContent("A-1"))).toBe("A-1");
  });

  test("home, the root, trailing slashes and ~ paths", () => {
    expect(cwdName("~")).toBe("~");
    expect(cwdName("~/")).toBe("~");
    expect(cwdName("/")).toBe("/");
    expect(cwdName("/Users/me/code/")).toBe("code");
    expect(cwdName("~/code/app")).toBe("app");
  });
});

describe("watchPaneStore", () => {
  const saved = (globalThis as { localStorage?: Storage }).localStorage;
  beforeEach(() => {
    const data = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    reloadPanes();
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = saved;
    reloadPanes();
  });

  test("reports each change with the store before and after, and nothing once unsubscribed", () => {
    const seen: string[][] = [];
    const stop = watchPaneStore((before, after) => seen.push(closedSessions(before, after)));
    updatePanes("a", (s) => openTerminal(s, term("t:1")));
    updatePanes("a", (s) => s); // a no-op isn't a change
    const leaf = terminalLeafBySession(getPanes("a").root, "t:1")!;
    updatePanes("a", (s) => closePane(s, leaf.id));
    stop();
    updatePanes("a", (s) => openTerminal(s, term("t:2")));
    expect(seen).toEqual([[], ["t:1"]]);
  });
});

describe("paneInDirection (⌥⌘arrows / ⌃hjkl)", () => {
  //  B | A
  //    |---
  //    | C
  const tree = () => st(row("r", [B, col("c", [T("A"), T("C")])], [0.5, 0.5]));
  const go = (s: PaneState, from: string, dir: "left" | "right" | "up" | "down", sidebar = false) => paneInDirection(layoutPanes(s), from, dir, { sidebar });

  test("moves across a row and down a column", () => {
    expect(go(tree(), "B", "right")).toBe("A"); // both A and C border B: the topmost wins the tie
    expect(go(tree(), "A", "down")).toBe("C");
    expect(go(tree(), "C", "up")).toBe("A");
    expect(go(tree(), "C", "left")).toBe("B");
  });

  test("prefers the pane sharing more of the edge", () => {
    // B beside a column where A is a sliver on top and C fills most of the height.
    const s = st(row("r", [B, col("c", [T("A"), T("C")], [0.2, 0.8])], [0.5, 0.5]));
    expect(go(s, "B", "right")).toBe("C");
  });

  test("picks the nearest pane beyond the edge, not a farther one", () => {
    const s = st(row("r", [B, T("A"), T("C")]));
    expect(go(s, "B", "right")).toBe("A");
    expect(go(s, "C", "left")).toBe("A");
  });

  test("a pane that doesn't overlap across the axis isn't a neighbour", () => {
    // B above A on the left; C on the right, full height. From A, up is B, and nothing is below.
    const s = st(row("r", [col("c", [B, T("A")]), T("C")]));
    expect(go(s, "A", "up")).toBe("B");
    expect(go(s, "A", "down")).toBeNull();
    expect(go(s, "A", "right")).toBe("C");
  });

  test("left from the left edge is the sidebar only when it's open", () => {
    expect(go(tree(), "B", "left", true)).toBe("sidebar");
    expect(go(tree(), "B", "left", false)).toBeNull();
    // A isn't on the left edge: left goes to B, never the sidebar.
    expect(go(tree(), "A", "left", true)).toBe("B");
  });

  test("while zoomed the other panes are hidden, so there is nowhere to go but the sidebar", () => {
    const s = st(tree().root, "A", "A");
    expect(go(s, "A", "down")).toBeNull();
    expect(go(s, "A", "left", true)).toBe("sidebar");
  });

  test("an unknown or hidden starting pane goes nowhere", () => {
    expect(go(tree(), "nope", "right")).toBeNull();
    expect(go(st(tree().root, "A", "A"), "B", "right")).toBeNull();
  });
});

describe("New session panes (compose)", () => {
  const C = (id: string): PaneLeaf => ({ type: "leaf", id: `c-${id}`, content: { kind: "compose", id } });

  test("every open adds another New session pane, docked right of the focused pane like a terminal", () => {
    const one = valid(openCompose(st(row("r", [B, T("A-1")], [0.6, 0.4]), "A-1")));
    const two = valid(openCompose(one));
    const composes = leaves(two.root).filter((l) => l.content.kind === "compose");
    expect(composes.length).toBe(2);
    expect(new Set(composes.map((l) => (l.content as { id: string }).id)).size).toBe(2);
    // The first split the ticket pane; the second split the first (it was focused).
    expect(shape(two.root)).toMatch(/^row\[board 0\.6, A-1 0\.2, \+n\d+ 0\.1, \+n\d+ 0\.1\]$/);
    expect(findLeaf(two.root, two.focusedId!)!.content).toEqual(composes[1]!.content);
  });

  test("with nothing focused it docks beside the board, which keeps its share", () => {
    const s = valid(openCompose(defaultPanes("B")));
    expect(shape(s.root)).toMatch(/^row\[board 0\.6, \+n\d+ 0\.4\]$/);
  });

  test("the same content twice focuses the open pane instead of opening another", () => {
    const content = newComposeContent("proj-1");
    const once = openCompose(defaultPanes("B"), null, content);
    const again = openCompose({ ...once, focusedId: "B" }, null, content);
    expect(leaves(again.root).length).toBe(2);
    expect(again.focusedId).toBe(composeLeafById(once.root, content.id)!.id);
    expect(content.projectId).toBe("proj-1");
  });

  test("normalize keeps at most one leaf per New session id", () => {
    const s = normalize(st(row("r", [B, C("x"), { ...C("x"), id: "dup" }])));
    expect(leaves(s.root).filter((l) => l.content.kind === "compose").length).toBe(1);
    expect(checkPanes(st(row("r", [B, C("x"), { ...C("x"), id: "dup" }])))).toContain("New session x is open twice");
  });

  test("saving swaps the pane to the ticket in place: same leaf id, same size, same focus", () => {
    const start = valid(normalize(st(row("r", [B, T("A-1"), C("x")], [0.5, 0.2, 0.3]), "c-x")));
    const s = valid(composeToTicket(start, "x", "A-7"));
    const leaf = findLeaf(s.root, "c-x")!;
    expect(leaf.content).toEqual({ kind: "ticket", ticketKey: "A-7", tab: "spec" });
    expect(shape(s.root)).toBe("row[board 0.5, A-1 0.2, A-7 0.3]");
    expect(s.focusedId).toBe("c-x");
    expect(composeToTicket(start, "nope", "A-7")).toBe(start);
  });

  test("saving as a ticket that's already open closes the New session and focuses that pane", () => {
    const start = normalize(st(row("r", [B, T("A-1"), C("x")], [0.5, 0.2, 0.3]), "c-x"));
    const s = valid(composeToTicket(start, "x", "A-1"));
    expect(shape(s.root)).toBe("row[board 0.5, A-1 0.5]");
    expect(s.focusedId).toBe("A-1");
  });

  test("New session panes are never stored: serializing drops them, and their focus", () => {
    const s = normalize(st(row("r", [B, T("A-1"), C("x")], [0.5, 0.25, 0.25]), "c-x", "c-x"));
    const back = parsePanes(serializePanes(s));
    expect(shape(back.root)).toBe("row[board 0.667, A-1 0.333]");
    expect(back.focusedId).toBeNull();
    expect(back.zoomedId).toBeNull();
    const store = parsePaneStore(serializePaneStore({ scopes: { [ALL_SCOPE]: s, p1: normalize(st(row("r2", [{ ...B, id: "B2" }, C("y")]))) } }));
    expect(shape(store.scopes[ALL_SCOPE]!.root)).toBe("row[board 0.667, A-1 0.333]");
    expect(shape(store.scopes.p1!.root)).toBe("board");
  });

  test("a stored New session (from anywhere) doesn't parse back", () => {
    const raw = JSON.stringify({ root: { type: "split", id: "r", dir: "row", children: [B, C("x")], sizes: [0.5, 0.5] }, focusedId: null, zoomedId: null });
    expect(shape(parsePanes(raw).root)).toBe("board");
  });

  test("labels and minimum width", () => {
    expect(paneLabel({ kind: "compose", id: "x" })).toBe("New session");
    expect(minSize(C("x"), "row")).toBe(PANE_MIN_WIDTH.compose);
    expect(PANE_MIN_WIDTH.compose).toBe(360);
  });

  test("Escape closes a focused New session pane", () => {
    const s = normalize(st(row("r", [B, C("x")]), "c-x"));
    expect(shape(escapePanes(s).root)).toBe("board");
  });
});

describe("file panes", () => {
  const file = (path: string, extra: Partial<FileContent> = {}, root: FileContent["root"] = { ticketKey: "A-1" }): FileContent => ({ kind: "file", root, path, ...extra });
  const F = (id: string, c: FileContent): PaneLeaf => ({ type: "leaf", id, content: c });

  test("opening from a ticket pane docks the file on its right and focuses it", () => {
    const s = valid(openFile(st(row("r", [B, T("A-1")], [0.6, 0.4]), "A-1"), file("src/app.ts", { startLine: 10, endLine: 20 }), "A-1"));
    expect(shape(s.root)).toBe("row[board 0.6, A-1 0.2, @src/app.ts:10-20 0.2]");
    expect(focusedLabel(s)).toBe("@src/app.ts:10-20");
  });

  test("the same file (root + path) reuses its pane and moves it to the new lines", () => {
    const s0 = st(row("r", [B, T("A-1"), F("f", file("src/app.ts", { startLine: 10, endLine: 20 }))]), "A-1");
    const s = valid(openFile(s0, file("src/app.ts", { startLine: 40 }), "A-1"));
    expect(shape(s.root)).toBe("row[board 0.333, A-1 0.333, @src/app.ts:40 0.333]");
    expect(s.focusedId).toBe("f");
  });

  test("following lines into an open diff switches it back to the File tab; a link without lines keeps the tab", () => {
    const s0 = st(row("r", [B, F("f", file("a.ts", { tab: "diff" }))]));
    expect(focusedLabel(openFile(s0, file("a.ts", { startLine: 3 })))).toBe("@a.ts:3");
    expect(focusedLabel(openFile(s0, file("a.ts")))).toBe("@a.ts(diff)");
  });

  test("the same path under another root is a different file", () => {
    const s0 = st(row("r", [B, T("A-1"), F("f", file("a.ts"))]), "B");
    const s = valid(openFile(s0, file("a.ts", {}, { projectId: "proj" }), "B"));
    expect(leaves(s.root).filter((l) => l.content.kind === "file")).toHaveLength(2);
  });

  test("a different file replaces the file pane right after the pane it's opened from", () => {
    const s0 = st(row("r", [B, T("A-1"), F("f", file("a.ts", { startLine: 2 }))], [0.4, 0.3, 0.3]), "A-1");
    const s = valid(openFile(s0, file("b.ts"), "A-1"));
    expect(shape(s.root)).toBe("row[board 0.4, A-1 0.3, @b.ts 0.3]");
    expect(s.focusedId).toBe("f");
  });

  test("opened from a file pane (the palette over it), a different file replaces that pane", () => {
    const s0 = st(row("r", [B, T("A-1"), F("f", file("a.ts", { startLine: 2 }))], [0.4, 0.3, 0.3]), "f");
    const s = valid(openFile(s0, file("b.ts", { startLine: 5 }), "f"));
    expect(shape(s.root)).toBe("row[board 0.4, A-1 0.3, @b.ts:5 0.3]");
    expect(s.focusedId).toBe("f");
    // The focused pane counts when no source is named.
    const s2 = valid(openFile(s0, file("c.ts")));
    expect(shape(s2.root)).toBe("row[board 0.4, A-1 0.3, @c.ts 0.3]");
  });

  test("a file pane elsewhere (not right after the source) doesn't get replaced", () => {
    const s0 = st(row("r", [B, F("f", file("a.ts")), T("A-1")], [0.4, 0.3, 0.3]), "A-1");
    const s = valid(openFile(s0, file("b.ts"), "A-1"));
    expect(shape(s.root)).toBe("row[board 0.4, @a.ts 0.3, A-1 0.15, @b.ts 0.15]");
  });

  test("bad line numbers are dropped, and an end before the start isn't a range", () => {
    const s = valid(openFile(defaultPanes(), file("a.ts", { startLine: 0, endLine: 5 })));
    expect(focusedLabel(s)).toBe("@a.ts");
    const s2 = valid(openFile(defaultPanes(), file("a.ts", { startLine: 7, endLine: 7 })));
    expect(focusedLabel(s2)).toBe("@a.ts:7");
  });

  test("normalize drops a second pane on the same file; checkPanes reports it", () => {
    const bad = st(row("r", [B, F("f1", file("a.ts")), F("f2", file("a.ts", { startLine: 3 }))]));
    expect(checkPanes(bad).join("\n")).toContain("file a.ts is open twice");
    expect(shape(valid(normalize(bad)).root)).toBe("row[board 0.5, @a.ts 0.5]");
  });

  test("setFileView switches tabs and lines in place, and is a no-op when nothing changes", () => {
    const s0 = st(row("r", [B, F("f", file("a.ts", { startLine: 3 }))]), "f");
    const diff = setFileView(s0, "f", { tab: "diff" });
    expect(focusedLabel(diff)).toBe("@a.ts:3(diff)");
    expect(focusedLabel(setFileView(diff, "f", { tab: "file", lines: { startLine: 8, endLine: 9 } }))).toBe("@a.ts:8-9");
    expect(focusedLabel(setFileView(s0, "f", { lines: null }))).toBe("@a.ts");
    expect(setFileView(s0, "f", { tab: "file", lines: { startLine: 3 } })).toBe(s0);
    expect(setFileView(s0, "B", { tab: "diff" })).toBe(s0);
  });

  test("Escape closes a focused file pane", () => {
    const s = normalize(st(row("r", [B, F("f", file("a.ts"))]), "f"));
    expect(shape(escapePanes(s).root)).toBe("board");
  });

  test("paneLabel is the file's name, and file panes have a minimum width", () => {
    expect(paneLabel(file("src/deep/app.ts"))).toBe("app.ts");
    expect(minSize(F("f", file("a.ts")), "row")).toBe(PANE_MIN_WIDTH.file);
  });

  test("a renamed ticket's file panes follow it; a deleted ticket's close", () => {
    const s0 = st(row("r", [B, T("A-1"), F("f", file("a.ts")), F("g", file("b.ts", {}, { projectId: "p" }))]), "f");
    const renamed = valid(renameTicketKey(s0, "A-1", "Z-1"));
    const f = findLeaf(renamed.root, "f")!.content as FileContent;
    expect(f.root).toEqual({ ticketKey: "Z-1" });
    expect(shape(renamed.root)).toBe("row[board 0.25, Z-1 0.25, @a.ts 0.25, @b.ts 0.25]");
    const pruned = valid(pruneTickets(s0, (k) => k !== "A-1"));
    expect(leaves(pruned.root).map(label)).toEqual(["board", "@b.ts"]);
  });

  test("a rename onto a key whose file pane is already open closes the duplicate", () => {
    const s0 = st(row("r", [B, F("f", file("a.ts")), F("g", file("a.ts", {}, { ticketKey: "Z-1" }))]), "f");
    const s = valid(renameTicketKey(s0, "A-1", "Z-1"));
    expect(shape(s.root)).toBe("row[board 0.5, @a.ts 0.5]");
    expect(s.focusedId).toBe("g");
  });

  test("file panes persist (root, path, lines, tab) and junk file entries are dropped", () => {
    const s0 = st(row("r", [B, F("f", file("src/a.ts", { startLine: 4, endLine: 9, tab: "diff" })), F("g", file("b.ts", {}, { projectId: "p" }))]), "f");
    const back = parsePanes(serializePanes(s0));
    expect(shape(back.root)).toBe(shape(s0.root));
    expect(findLeaf(back.root, "g")!.content).toEqual(file("b.ts", {}, { projectId: "p" }));
    const junk = JSON.stringify({
      root: {
        type: "split",
        id: "r",
        dir: "row",
        children: [
          { type: "leaf", id: "B", content: { kind: "board" } },
          { type: "leaf", id: "x", content: { kind: "file", path: "a.ts", root: {} } },
          { type: "leaf", id: "y", content: { kind: "file", path: "", root: { ticketKey: "A-1" } } },
          { type: "leaf", id: "z", content: { kind: "file", path: "c.ts", root: { ticketKey: "A-1" }, startLine: -3, endLine: "x", tab: "weird" } },
        ],
        sizes: [1, 1, 1, 1],
      },
    });
    const parsed = parsePanes(junk);
    expect(shape(parsed.root)).toBe("row[board 0.5, @c.ts 0.5]");
  });
});

// ---------------------------------------------------------------------------
// Torn-off tabs
// ---------------------------------------------------------------------------

describe("torn-off tabs", () => {
  /** A torn-off tab's leaf; its id names it ("A-1/transcript", "A-1/browser#3"). */
  const TT = (key: string, tab: TornTab, browserTab?: number): PaneLeaf => ({
    type: "leaf",
    id: `${key}/${tab}${browserTab !== undefined ? `#${browserTab}` : ""}`,
    content: tabContent({ ticketKey: key, tab, browserTab }),
  });
  const tabDrag = (ticketKey: string, tab: TornTab, browserTab?: number): DragSource => ({ kind: "tab", ticketKey, tab, ...(browserTab !== undefined ? { browserTab } : {}) });
  const pop = (leaf: PaneLeaf): PaneState => ({ root: leaf, focusedId: leaf.id, zoomedId: null });
  const tabOf = (s: PaneState | undefined, id: string) => {
    const c = s && findLeaf(s.root, id)?.content;
    return c && (c.kind === "ticket" || c.kind === "ticketTab") ? c.tab : null;
  };

  test("normalize keeps one pane per ticket and tab, and per ticket and browser tab", () => {
    const s = normalize(
      st(
        row("r", [
          B,
          TT("A-1", "transcript"),
          { ...TT("A-1", "transcript"), id: "dup" },
          TT("A-2", "transcript"),
          TT("A-1", "agents"),
          // A sub-agent's transcript is the Agents tab's: the same torn-off tab.
          { ...TT("A-1", "agent:x"), id: "dup-agent" },
          TT("A-1", "browser"),
          TT("A-1", "browser", 3),
          { ...TT("A-1", "browser", 3), id: "dup-pin" },
          TT("A-1", "browser", 4),
          TT("A-1", "composer"),
          { ...TT("A-1", "composer"), id: "dup-composer" },
        ]),
      ),
    );
    expect(valid(s) && leaves(s.root).map((l) => l.id)).toEqual(["B", "A-1/transcript", "A-2/transcript", "A-1/agents", "A-1/browser", "A-1/browser#3", "A-1/browser#4", "A-1/composer"]);
  });

  test("checkPanes catches a tab torn off twice", () => {
    expect(checkPanes(st(row("r", [B, TT("A-1", "spec"), { ...TT("A-1", "spec"), id: "x" }])))).toEqual(["A-1 · Spec is torn off twice"]);
    expect(checkPanes(st(row("r", [B, TT("A-1", "browser", 2), { ...TT("A-1", "browser", 2), id: "x" }])))).toEqual(["A-1 · Browser tab is torn off twice"]);
    // The ticket pane and its torn-off tab are different panes.
    expect(checkPanes(st(row("r", [B, T("A-1", "transcript"), TT("A-1", "transcript")])))).toEqual([]);
  });

  test("a tab dropped beside its ticket docks there; dropped again it moves, never duplicates", () => {
    const start = st(row("r", [B, T("A-1"), T("A-2")]));
    const once = valid(applyDrop(start, tabDrag("A-1", "transcript"), "A-1", "right"));
    expect(shape(once.root)).toBe("row[board 0.333, A-1 0.167, A-1/transcript 0.167, A-2 0.333]");
    const id = once.focusedId!;
    expect(label(findLeaf(once.root, id)!)).toBe("A-1/transcript");
    const twice = valid(applyDrop(once, tabDrag("A-1", "transcript"), "A-2", "bottom"));
    expect(shape(twice.root)).toBe("row[board 0.333, A-1 0.25, col[A-2 0.5, A-1/transcript 0.5] 0.417]");
    expect(twice.focusedId).toBe(id);
    // dropContent dedupes the same way.
    const again = valid(dropContent(twice, "B", "left", tabContent({ ticketKey: "A-1", tab: "transcript" })));
    expect(leaves(again.root).filter((l) => l.content.kind === "ticketTab")).toHaveLength(1);
  });

  test("a torn-off Agents pane on a sub-agent moves as the Agents tab, keeping the sub-agent", () => {
    const start = st(row("r", [B, T("A-1"), TT("A-1", "agent:x")]));
    const s = valid(applyDrop(start, tabDrag("A-1", "agents"), "B", "bottom"));
    expect(leaves(s.root).map(label)).toEqual(["board", "A-1/agent:x", "A-1"]);
  });

  test("a pinned browser tab and the whole Browser tab are separate panes", () => {
    const s = valid(applyDrop(st(row("r", [B, T("A-1")])), tabDrag("A-1", "browser", 2), "A-1", "right"));
    const both = valid(applyDrop(s, tabDrag("A-1", "browser"), "A-1", "bottom"));
    expect(leaves(both.root).map(label).sort()).toEqual(["A-1", "A-1/browser", "A-1/browser#2", "board"]);
    // A browserTab only goes with the Browser tab.
    expect(tabContent({ ticketKey: "A-1", tab: "spec", browserTab: 2 })).toEqual({ kind: "ticketTab", ticketKey: "A-1", tab: "spec" });
  });

  test("tornOffTabs: in the board's tree, in a pop-out, and not torn off; another board doesn't count", () => {
    const store: PaneStore = {
      scopes: {
        a: st(row("r", [B, T("A-1"), TT("A-1", "transcript"), TT("A-2", "spec")])),
        b: st(row("r2", [{ ...B, id: "B2" }, TT("A-1", "details")])),
        [popoutScope("w1")]: pop(TT("A-1", "browser", 3)),
        [popoutScope("w2")]: pop(TT("A-1", "composer")),
      },
    };
    const torn = tornOffTabs(store, "A-1", "a");
    expect([...torn.keys()].sort()).toEqual(["browser:3", "composer", "transcript"]);
    expect(torn.get("transcript")).toMatchObject({ scope: "a", leafId: "A-1/transcript", window: false });
    expect(torn.get("browser:3")).toMatchObject({ scope: popoutScope("w1"), window: true });
    expect(torn.has("details")).toBe(false);
    expect(torn.has("spec")).toBe(false);
    expect([...tornOffTabs(store, "A-1", "b").keys()].sort()).toEqual(["browser:3", "composer", "details"]);
    expect(tornOffTabs(store, "A-9", "a").size).toBe(0);
  });

  test("Return to this window closes the pane and shows the tab in the ticket pane, focused", () => {
    const store: PaneStore = { scopes: { a: st(row("r", [B, T("A-1", "spec"), TT("A-1", "transcript")]), "B") } };
    const next = returnTab(store, "a", "A-1", "transcript");
    expect(leaves(next.scopes.a!.root).map(label)).toEqual(["board", "A-1"]);
    expect(tabOf(next.scopes.a, "A-1")).toBe("transcript");
    expect(next.scopes.a!.focusedId).toBe("A-1");
    // Not torn off: nothing to return.
    expect(returnTab(store, "a", "A-1", "details")).toBe(store);
  });

  test("Return to this window closes a pop-out window, and reaches a ticket pane that's popped out too", () => {
    const store: PaneStore = {
      scopes: {
        a: st(row("r", [B, T("A-2")])),
        [popoutScope("w1")]: pop(TT("A-1", "browser", 3)),
        [popoutScope("w2")]: pop(T("A-1", "spec")),
      },
    };
    const next = returnTab(store, "a", "A-1", "browser:3");
    expect(next.scopes[popoutScope("w1")]).toBeUndefined();
    // A browser tab comes back on the Browser tab.
    expect(tabOf(next.scopes[popoutScope("w2")], "A-1")).toBe("browser");
    expect(next.scopes.a).toBe(store.scopes.a);
  });

  test("the composer tears off like a tab, and comes back without changing the ticket's tab", () => {
    const start: PaneStore = { scopes: { a: st(row("r", [B, T("A-1", "transcript")])) } };
    const torn = dropInStore(start, "a", tabDrag("A-1", "composer"), "A-1", "bottom");
    expect(valid(torn.scopes.a!) && shape(torn.scopes.a!.root)).toBe("row[board 0.5, col[A-1 0.5, A-1/composer 0.5] 0.5]");
    // There's no composer tab to leave: the ticket stays on its Transcript.
    expect(tabOf(torn.scopes.a, "A-1")).toBe("transcript");
    expect([...tornOffTabs(torn, "A-1", "a").keys()]).toEqual(["composer"]);
    const back = returnTab(torn, "a", "A-1", "composer");
    expect(leaves(back.scopes.a!.root).map(label)).toEqual(["board", "A-1"]);
    expect(tabOf(back.scopes.a, "A-1")).toBe("transcript");
    // Its pane is as narrow as a ticket's, and as short as any pane.
    expect(minSize(TT("A-1", "composer"), "row")).toBe(360);
    expect(minSize(TT("A-1", "composer"), "column")).toBe(200);
  });

  test("tearing off the tab the ticket pane shows moves the ticket pane to the first tab still there", () => {
    const start: PaneStore = { scopes: { a: st(row("r", [B, T("A-1", "transcript")])), [popoutScope("w")]: pop(TT("A-1", "spec")) } };
    const next = dropInStore(start, "a", tabDrag("A-1", "transcript"), "A-1", "right");
    expect(tabOf(next.scopes.a, "A-1")).toBe("activity");
    // Another tab torn off leaves the ticket where it is.
    const other = dropInStore(start, "a", tabDrag("A-1", "details"), "A-1", "right");
    expect(tabOf(other.scopes.a, "A-1")).toBe("transcript");
  });

  test("dropping a tab (or a ticket) that's in a pop-out brings it back from that window instead of opening it twice", () => {
    const store: PaneStore = {
      scopes: {
        a: st(row("r", [B, T("A-2")])),
        [popoutScope("w1")]: pop(TT("A-1", "agent:x")),
        [popoutScope("w2")]: pop(T("A-3", "details")),
      },
    };
    const tab = dropInStore(store, "a", tabDrag("A-1", "agents"), "A-2", "right");
    expect(tab.scopes[popoutScope("w1")]).toBeUndefined();
    expect(leaves(tab.scopes.a!.root).map(label)).toEqual(["board", "A-2", "A-1/agent:x"]);
    const card = dropInStore(store, "a", { kind: "ticket", ticketKey: "A-3" }, "A-2", "right");
    expect(card.scopes[popoutScope("w2")]).toBeUndefined();
    expect(ticketLeafByKey(card.scopes.a!.root, "A-3")!.content).toEqual(ticketContent("A-3", "details" as "spec"));
    // A drop that does nothing leaves the store as it is.
    expect(dropInStore(store, "a", { kind: "pane", leafId: "A-2" }, "A-2", "left")).toBe(store);
  });

  test("pruneTickets closes torn-off tabs with their ticket; renameTicketKey follows the rename", () => {
    const s = st(row("r", [B, T("A-1"), TT("A-1", "transcript"), TT("A-2", "spec")]), "A-1/transcript");
    expect(leaves(valid(pruneTickets(s, (k) => k !== "A-1")).root).map(label)).toEqual(["board", "A-2/spec"]);
    const renamed = valid(renameTicketKey(s, "A-1", "B-1"));
    expect(leaves(renamed.root).map(label)).toEqual(["board", "B-1", "B-1/transcript", "A-2/spec"]);
    expect(renamed.focusedId).toBe("A-1/transcript");
    // The new key's tab is already torn off: the old one closes, and the focus goes to the survivor.
    const clash = valid(renameTicketKey(st(row("r", [B, TT("A-1", "spec"), TT("B-1", "spec")]), "A-1/spec"), "A-1", "B-1"));
    expect(leaves(clash.root).map(label)).toEqual(["board", "B-1/spec"]);
    expect(clash.focusedId).toBe("B-1/spec");
  });

  test("closing the ticket pane leaves its torn-off tabs open", () => {
    const s = valid(closePane(st(row("r", [B, T("A-1"), TT("A-1", "transcript")])), "A-1"));
    expect(leaves(s.root).map(label)).toEqual(["board", "A-1/transcript"]);
  });

  test("Escape closes a focused torn-off tab", () => {
    expect(leaves(escapePanes(st(row("r", [B, TT("A-1", "spec")]), "A-1/spec")).root).map(label)).toEqual(["board"]);
  });

  test("a focused torn-off tab mirrors its ticket in the route: the ticket pane's tab, or the Spec", () => {
    expect(focusedTicket(st(row("r", [B, T("A-1", "details"), TT("A-1", "transcript")]), "A-1/transcript"))).toEqual({ ticketKey: "A-1", tab: "details" });
    expect(focusedTicket(st(row("r", [B, TT("A-1", "transcript")]), "A-1/transcript"))).toEqual({ ticketKey: "A-1", tab: "spec" });
  });

  test("setTornTab moves inside the torn-off tab, never to another tab", () => {
    const s = st(row("r", [B, TT("A-1", "agents"), TT("A-1", "browser", 1)]));
    expect(tabOf(setTornTab(s, "A-1/agents", "agent:abc"), "A-1/agents")).toBe("agent:abc");
    expect(setTornTab(s, "A-1/agents", "transcript")).toBe(s);
    expect(setTornTab(s, "A-1/browser#1", "browser")).toBe(s);
    expect(setTornTab(s, "B", "agents")).toBe(s);
  });

  test("torn-off panes persist; unknown tabs and a stray browserTab are dropped", () => {
    const s = st(row("r", [B, T("A-1"), TT("A-1", "composer"), TT("A-1", "browser", 2), TT("A-1", "plugin:git:log")]));
    const back = parsePanes(serializePanes(s));
    expect(shape(back.root)).toBe(shape(normalize(s).root));
    const junk = parsePanes(
      JSON.stringify({
        root: {
          type: "split",
          id: "r",
          dir: "row",
          children: [
            B,
            { type: "leaf", id: "x", content: { kind: "ticketTab", ticketKey: "A-1", tab: "nope" } },
            { type: "leaf", id: "y", content: { kind: "ticketTab", ticketKey: "", tab: "spec" } },
            { type: "leaf", id: "z", content: { kind: "ticketTab", ticketKey: "A-1", tab: "spec", browserTab: 3 } },
            { type: "leaf", id: "w", content: { kind: "ticketTab", ticketKey: "A-1", tab: "browser", browserTab: -1 } },
            { type: "leaf", id: "v", content: { kind: "ticketTab", ticketKey: "A-1", tab: "summaries" } },
          ],
        },
      }),
    );
    expect(leaves(junk.root).map(label)).toEqual(["board", "A-1/spec", "A-1/browser"]);
  });

  test("popOut and popIn move a torn-off pane to a window and back", () => {
    const store: PaneStore = { scopes: { a: st(row("r", [B, T("A-1"), TT("A-1", "transcript")])) } };
    const out = popOut(store, "a", "A-1/transcript", "w1");
    expect(out.scopes[popoutScope("w1")]!.root).toEqual(TT("A-1", "transcript"));
    expect(tornOffTabs(out, "A-1", "a").get("transcript")!.window).toBe(true);
    const back = popIn(out, "w1", "a");
    expect(back.scopes[popoutScope("w1")]).toBeUndefined();
    expect(leaves(back.scopes.a!.root).map(label).sort()).toEqual(["A-1", "A-1/transcript", "board"]);
  });

  describe("popOutContent", () => {
    const base: PaneStore = { scopes: { a: st(row("r", [B, T("A-1", "details"), TT("A-1", "transcript")])) } };

    test("an open ticket moves into the window with its pane, rather than open twice", () => {
      const next = popOutContent(base, "a", { kind: "ticket", ticketKey: "A-1", tab: "spec" }, "w1");
      expect(next.scopes[popoutScope("w1")]!.root).toEqual(T("A-1", "details"));
      expect(leaves(next.scopes.a!.root).map(label)).toEqual(["board", "A-1/transcript"]);
    });

    test("a closed ticket gets a new pane, with an id no scope uses", () => {
      const next = popOutContent(base, "a", { kind: "ticket", ticketKey: "A-2", tab: "spec" }, "w1");
      const leaf = next.scopes[popoutScope("w1")]!.root as PaneLeaf;
      expect(leaf.content).toEqual(ticketContent("A-2"));
      expect(["B", "A-1", "A-1/transcript", "r"]).not.toContain(leaf.id);
      expect(next.scopes.a).toBe(base.scopes.a);
    });

    test("a tab already torn off moves; a new one leaves its ticket pane's tab", () => {
      const moved = popOutContent(base, "a", tabContent({ ticketKey: "A-1", tab: "transcript" }), "w1");
      expect(moved.scopes[popoutScope("w1")]!.root).toEqual(TT("A-1", "transcript"));
      expect(leaves(moved.scopes.a!.root).map(label)).toEqual(["board", "A-1"]);
      const fresh = popOutContent(base, "a", tabContent({ ticketKey: "A-1", tab: "details" }), "w2");
      expect(label(fresh.scopes[popoutScope("w2")]!.root as PaneLeaf)).toBe("A-1/details");
      expect(tabOf(fresh.scopes.a, "A-1")).toBe("spec");
    });

    test("the board, a New session, content already in a window and a taken id don't pop out", () => {
      expect(popOutContent(base, "a", { kind: "board" }, "w1")).toBe(base);
      expect(popOutContent(base, "a", newComposeContent(), "w1")).toBe(base);
      const out = popOutContent(base, "a", { kind: "ticket", ticketKey: "A-2", tab: "spec" }, "w1");
      expect(popOutContent(out, "a", { kind: "ticket", ticketKey: "A-2", tab: "spec" }, "w2")).toBe(out);
      expect(popoutShowing(out, { kind: "ticket", ticketKey: "A-2", tab: "spec" })!.scope).toBe(popoutScope("w1"));
      expect(popOutContent(out, "a", { kind: "ticket", ticketKey: "A-3", tab: "spec" }, "w1")).toBe(out);
    });
  });
});
