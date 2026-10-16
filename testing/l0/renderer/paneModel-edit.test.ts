import { beforeEach, describe, expect, test } from "bun:test";
import {
  closePane, equalizePanes, escapePanes, findLeaf, focusPane, leaves, pruneTickets, renameTicketKey, replaceContent, resetPaneIds, setSizes, setTab, setTerminalTitle, setTornTab, toggleZoom,
  type PaneState,
} from "../../../app/src/renderer/state/paneModel";
import { board, col, compose, file, findSplit, invariantErrors, row, shape, sizesOf, st, term, ticket, torn } from "./paneBuild";

beforeEach(() => resetPaneIds());

const near = (a: number[], b: number[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
};
const ok = (s: PaneState) => expect(invariantErrors(s)).toEqual([]);

describe("closePane", () => {
  const base = () => st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.5, 0.25, 0.25]));

  test("the board and unknown panes can't be closed", () => {
    const s = base();
    expect(closePane(s, "B")).toBe(s);
    expect(closePane(s, "ghost")).toBe(s);
    expect(closePane(s, "r")).toBe(s); // a split is not a pane
  });

  test("the board sibling takes the closed pane's whole share, others keep theirs", () => {
    const s = closePane(base(), "a");
    expect(shape(s.root)).toBe("row(B,b)");
    near(sizesOf(s.root), [0.75, 0.25]);
    const t = closePane(base(), "b");
    near(sizesOf(t.root), [0.75, 0.25]);
    ok(s);
    ok(t);
  });

  test("closing the last other pane leaves the bare board", () => {
    expect(shape(closePane(closePane(base(), "a"), "b").root)).toBe("B");
  });

  test("without the board in the split, the neighbour on the board's side inherits", () => {
    // board to the left of a column: closing the middle one hands space to the previous (board's side is "before")
    const left = closePane(st(row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2"), ticket("c", "A-3")], [0.2, 0.3, 0.5])])), "b");
    near(sizesOf(findSplit(left.root, "c")!), [0.5, 0.5]);
    // board after: next sibling inherits
    const right = closePane(st(row("r", [col("c", [ticket("a", "A-1"), ticket("b", "A-2"), ticket("c", "A-3")], [0.2, 0.3, 0.5]), board("B")])), "b");
    near(sizesOf(findSplit(right.root, "c")!), [0.2, 0.8]);
  });

  test("closing the first of a column with the board elsewhere gives the space to the next", () => {
    const s = closePane(st(row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2"), ticket("c", "A-3")], [0.2, 0.3, 0.5])])), "a");
    near(sizesOf(findSplit(s.root, "c")!), [0.5, 0.5]);
  });

  test("closing the focused pane focuses the next sibling's first leaf, else the previous one's last", () => {
    expect(closePane({ ...base(), focusedId: "a" }, "a").focusedId).toBe("b");
    expect(closePane({ ...base(), focusedId: "b" }, "b").focusedId).toBe("a");
    const nested = st(row("r", [board("B"), col("c", [ticket("a", "A-1"), row("x", [term("y", "s"), term("z", "s2")])])]), "a");
    expect(closePane(nested, "a").focusedId).toBe("y");
    const nested2 = st(row("r", [board("B"), col("c", [row("x", [term("y", "s"), term("z", "s2")]), ticket("a", "A-1")])]), "a");
    expect(closePane(nested2, "a").focusedId).toBe("z");
  });

  test("closing another pane keeps the focus; closing the zoomed pane ends the zoom, others keep it", () => {
    expect(closePane({ ...base(), focusedId: "b" }, "a").focusedId).toBe("b");
    expect(closePane({ ...base(), zoomedId: "a" }, "a").zoomedId).toBeNull();
    expect(closePane({ ...base(), zoomedId: "b" }, "a").zoomedId).toBe("b");
  });
});

describe("escapePanes", () => {
  const root = row("r", [board("B"), ticket("t", "A-1"), term("x", "s"), torn("g", "A-1"), file("f", "p"), compose("n", "k")]);
  test("a zoom ends first", () => {
    const s = escapePanes(st(root, "t", "t"));
    expect(s.zoomedId).toBeNull();
    expect(leaves(s.root)).toHaveLength(6);
  });
  test("closes a focused ticket, torn-off tab, file or New session", () => {
    for (const id of ["t", "g", "f", "n"]) expect(findLeaf(escapePanes(st(root, id)).root, id)).toBeNull();
  });
  test("never the board or a terminal; nothing focused does nothing", () => {
    for (const id of ["B", "x", null]) {
      const s = st(root, id);
      expect(escapePanes(s)).toBe(s);
    }
  });
});

describe("setTab / setTornTab / setTerminalTitle", () => {
  const s = st(row("r", [board("B"), ticket("t", "A-1", "spec"), torn("g", "A-1", "transcript"), { ...torn("a", "A-1", "details"), content: { kind: "ticketTab", ticketKey: "A-1", tab: "agents" } }, torn("br", "A-1", "browser", 2), term("x", "s")], [0.4, 0.15, 0.15, 0.1, 0.1, 0.1]));

  test("setTab changes a ticket pane's tab only", () => {
    expect((findLeaf(setTab(s, "t", "details").root, "t")!.content as { tab: string }).tab).toBe("details");
    expect(setTab(s, "t", "spec")).toBe(s);
    expect(setTab(s, "x", "details")).toBe(s);
    expect(setTab(s, "g", "details")).toBe(s);
    expect(setTab(s, "ghost", "details")).toBe(s);
  });

  test("setTornTab navigates within the same torn tab (Agents <-> a sub-agent) and nothing else", () => {
    const into = setTornTab(s, "a", "agent:abc");
    expect((findLeaf(into.root, "a")!.content as { tab: string }).tab).toBe("agent:abc");
    expect(setTornTab(into, "a", "agents")).not.toBe(into);
    expect(setTornTab(s, "a", "agents")).toBe(s); // same tab
    expect(setTornTab(s, "g", "details")).toBe(s); // would become another tab
    expect(setTornTab(s, "br", "agents")).toBe(s); // a pinned browser tab never navigates
    expect(setTornTab(s, "t", "details")).toBe(s); // not a torn-off pane
    expect(setTornTab(s, "ghost", "details")).toBe(s);
  });

  test("setTerminalTitle sets, replaces and clears a title; unchanged or non-terminals are no-ops", () => {
    const set = setTerminalTitle(s, "x", "vim");
    expect(findLeaf(set.root, "x")!.content).toMatchObject({ title: "vim", sessionId: "s" });
    expect(setTerminalTitle(set, "x", "vim")).toBe(set);
    const cleared = setTerminalTitle(set, "x", "");
    expect("title" in findLeaf(cleared.root, "x")!.content).toBe(false);
    expect(setTerminalTitle(s, "x", "")).toBe(s); // untitled stays untitled
    expect(setTerminalTitle(s, "t", "nope")).toBe(s);
    expect(setTerminalTitle(s, "ghost", "nope")).toBe(s);
  });
});

describe("replaceContent", () => {
  const base = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2", "details")]));
  test("the board pane and unknown panes can't navigate", () => {
    expect(replaceContent(base, "B", { kind: "ticket", ticketKey: "A-9", tab: "spec" })).toBe(base);
    expect(replaceContent(base, "ghost", { kind: "ticket", ticketKey: "A-9", tab: "spec" })).toBe(base);
  });
  test("replaces in place and focuses", () => {
    const s = replaceContent(base, "a", { kind: "ticket", ticketKey: "A-9", tab: "spec" });
    expect(findLeaf(s.root, "a")!.content).toMatchObject({ ticketKey: "A-9" });
    expect(s.focusedId).toBe("a");
    ok(s);
  });
  test("content already open elsewhere is focused there with the requested tab, and this pane is untouched", () => {
    const s = replaceContent(base, "a", { kind: "ticket", ticketKey: "A-2", tab: "spec" });
    expect(findLeaf(s.root, "a")!.content).toMatchObject({ ticketKey: "A-1" });
    expect(findLeaf(s.root, "b")!.content).toMatchObject({ tab: "spec" });
    expect(s.focusedId).toBe("b");
    ok(s);
  });
  test("zoom survives only on the pane that is revealed", () => {
    expect(replaceContent({ ...base, zoomedId: "a" }, "a", { kind: "ticket", ticketKey: "A-9", tab: "spec" }).zoomedId).toBe("a");
    expect(replaceContent({ ...base, zoomedId: "B" }, "a", { kind: "ticket", ticketKey: "A-9", tab: "spec" }).zoomedId).toBeNull();
  });
});

describe("focusPane / toggleZoom", () => {
  const base = st(row("r", [board("B"), ticket("a", "A-1")]), "B");
  test("focusPane ignores unknown ids and no-op calls", () => {
    expect(focusPane(base, "ghost")).toBe(base);
    expect(focusPane(base, "r")).toBe(base);
    expect(focusPane(base, "B")).toBe(base);
    expect(focusPane(base, "a").focusedId).toBe("a");
  });
  test("focusing another pane ends a zoom; focusing the zoomed one keeps it", () => {
    expect(focusPane({ ...base, zoomedId: "B" }, "a")).toMatchObject({ focusedId: "a", zoomedId: null });
    expect(focusPane({ ...base, focusedId: "a", zoomedId: "B" }, "B")).toMatchObject({ focusedId: "B", zoomedId: "B" });
  });
  test("toggleZoom zooms (and focuses), then unzooms the same pane", () => {
    const z = toggleZoom(base, "a");
    expect(z).toMatchObject({ focusedId: "a", zoomedId: "a" });
    expect(toggleZoom(z, "a")).toMatchObject({ focusedId: "a", zoomedId: null });
  });
  test("defaults to the focused pane", () => {
    expect(toggleZoom(base).zoomedId).toBe("B");
  });
  test("zooming another pane while one is zoomed moves the zoom", () => {
    expect(toggleZoom({ ...base, zoomedId: "B" }, "a")).toMatchObject({ focusedId: "a", zoomedId: "a" });
  });
  test("nothing to zoom: a lone pane, no pane given, an unknown or split id", () => {
    const lone = st(board("B"), "B");
    expect(toggleZoom(lone, "B")).toBe(lone);
    expect(toggleZoom({ ...base, focusedId: null })).toEqual({ ...base, focusedId: null });
    expect(toggleZoom(base, "ghost")).toBe(base);
    expect(toggleZoom(base, "r")).toBe(base);
  });
});

describe("setSizes", () => {
  const base = st(row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2")])], [0.6, 0.4]));
  test("commits and re-normalizes the root split's sizes", () => {
    near(sizesOf(setSizes(base, "r", [3, 1]).root), [0.75, 0.25]);
  });
  test("reaches a nested split", () => {
    const s = setSizes(base, "c", [0.2, 0.8]);
    near(sizesOf(findSplit(s.root, "c")!), [0.2, 0.8]);
    near(sizesOf(s.root), [0.6, 0.4]);
  });
  test("ignored for a wrong length, a leaf, or an unknown id", () => {
    expect(setSizes(base, "r", [1])).toBe(base);
    expect(setSizes(base, "r", [0.3, 0.3, 0.4])).toBe(base);
    expect(setSizes(base, "B", [1, 1])).toBe(base);
    expect(setSizes(base, "ghost", [1, 1])).toBe(base);
  });
  test("unusable values fall back to an even split rather than a broken tree", () => {
    for (const sizes of [[0, 1], [-1, 2], [Number.NaN, 1]]) {
      const s = setSizes(base, "r", sizes);
      near(sizesOf(s.root), [0.5, 0.5]);
      ok(s);
    }
  });
});

describe("renameTicketKey", () => {
  const base = st(row("r", [board("B"), ticket("t", "A-1"), torn("g", "A-1", "transcript"), file("f", "p", { ticketKey: "A-1" }), file("fp", "p", { projectId: "A" }), ticket("u", "B-1")], [0.4, 0.15, 0.15, 0.1, 0.1, 0.1]));
  test("the same key is a no-op", () => {
    expect(renameTicketKey(base, "A-1", "A-1")).toBe(base);
  });
  test("the ticket pane, its torn-off tabs and its file panes follow; project files and other tickets don't", () => {
    const s = renameTicketKey(base, "A-1", "Z-1");
    expect(findLeaf(s.root, "t")!.content).toMatchObject({ ticketKey: "Z-1" });
    expect(findLeaf(s.root, "g")!.content).toMatchObject({ ticketKey: "Z-1" });
    expect(findLeaf(s.root, "f")!.content).toMatchObject({ root: { ticketKey: "Z-1" } });
    expect(findLeaf(s.root, "fp")!.content).toMatchObject({ root: { projectId: "A" } });
    expect(findLeaf(s.root, "u")!.content).toMatchObject({ ticketKey: "B-1" });
    ok(s);
  });
  test("an unrelated key changes nothing structurally", () => {
    expect(renameTicketKey(base, "Q-9", "Z-1").root).toBe(base.root);
  });
  test("renaming onto an open ticket closes the renamed pane and moves a focus on it to the other", () => {
    const s = renameTicketKey({ ...base, focusedId: "t" }, "A-1", "B-1");
    expect(findLeaf(s.root, "t")).toBeNull();
    expect(s.focusedId).toBe("u");
    ok(s);
  });
  test("renaming onto an open ticket keeps an unrelated focus", () => {
    expect(renameTicketKey({ ...base, focusedId: "B" }, "A-1", "B-1").focusedId).toBe("B");
  });
  test("a torn-off tab or file that would collide closes instead of duplicating", () => {
    const withB = st(row("r", [board("B"), torn("g", "A-1", "transcript"), torn("h", "B-1", "transcript"), file("f", "p", { ticketKey: "A-1" }), file("f2", "p", { ticketKey: "B-1" })]));
    const s = renameTicketKey(withB, "A-1", "B-1");
    expect(leaves(s.root).map((l) => l.id)).toEqual(["B", "h", "f2"]);
    ok(s);
  });
  test("a torn-off tab colliding while focused hands focus to the survivor", () => {
    const withB = st(row("r", [board("B"), torn("g", "A-1", "transcript"), torn("h", "B-1", "transcript")]), "g");
    expect(renameTicketKey(withB, "A-1", "B-1").focusedId).toBe("h");
  });
});

describe("pruneTickets", () => {
  const base = st(row("r", [board("B"), ticket("t", "A-1"), ticket("u", "B-1"), torn("g", "A-1"), file("f", "p", { ticketKey: "A-1" }), file("fp", "p", { projectId: "A" }), term("x", "s")], [0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2]));
  test("closes ticket panes, their torn-off tabs and ticket-rooted files for a vanished ticket, keeps the rest", () => {
    const s = pruneTickets(base, (k) => k !== "A-1");
    expect(leaves(s.root).map((l) => l.id)).toEqual(["B", "u", "fp", "x"]);
    ok(s);
  });
  test("nothing vanished keeps every pane", () => {
    expect(leaves(pruneTickets(base, () => true).root)).toHaveLength(7);
  });
  test("everything vanished leaves board, project file and terminal", () => {
    expect(leaves(pruneTickets(base, () => false).root).map((l) => l.id)).toEqual(["B", "fp", "x"]);
  });
});

describe("equalizePanes", () => {
  test("the board keeps its share, the others split the rest evenly", () => {
    const s = equalizePanes(st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2"), ticket("c", "A-3")], [0.4, 0.1, 0.2, 0.3])));
    near(sizesOf(s.root), [0.4, 0.2, 0.2, 0.2]);
    ok(s);
  });
  test("a split holding the board keeps that child's share, and nested splits equalize themselves", () => {
    const s = equalizePanes(st(row("r", [col("c", [board("B"), ticket("a", "A-1")], [0.7, 0.3]), col("d", [ticket("b", "A-2"), ticket("e", "A-3")], [0.9, 0.1])], [0.55, 0.45])));
    near(sizesOf(s.root), [0.55, 0.45]);
    near(sizesOf(findSplit(s.root, "c")!), [0.7, 0.3]);
    near(sizesOf(findSplit(s.root, "d")!), [0.5, 0.5]);
  });
  test("returns the same state when everything is already even", () => {
    const even = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.6, 0.2, 0.2]));
    expect(equalizePanes(even)).toBe(even);
    const lone = st(board("B"));
    expect(equalizePanes(lone)).toBe(lone);
  });
  test("a nested change alone still reports a change", () => {
    const s = st(row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2")], [0.8, 0.2])], [0.6, 0.4]));
    expect(equalizePanes(s)).not.toBe(s);
  });
});
