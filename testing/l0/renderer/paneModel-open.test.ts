import { beforeEach, describe, expect, test } from "bun:test";
import {
  BOARD_SHARE, COMPOSE_WIDTH_PX, PANE_MIN_WIDTH, composeToTicket, defaultPanes, findLeaf, leaves, openCompose, openCos, escapePanes, setCosTab, openFile, openTerminal, openTicket, openTicketAtRightEdge, openTicketInNewSplit,
  resetPaneIds, setFileView, type FileContent, type PaneLeaf, type PaneState,
} from "../../../app/src/renderer/state/paneModel";
import { board, col, compose, file, invariantErrors, row, shape, sizesOf, st, term, ticket } from "./paneBuild";

beforeEach(() => resetPaneIds());

const near = (a: number[], b: number[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
};
const bare = () => defaultPanes("B");
const ok = (s: PaneState) => expect(invariantErrors(s)).toEqual([]);
const added = (before: PaneState, after: PaneState): PaneLeaf => {
  const had = new Set(leaves(before.root).map((l) => l.id));
  const fresh = leaves(after.root).filter((l) => !had.has(l.id));
  expect(fresh).toHaveLength(1);
  return fresh[0]!;
};

describe("openTicket", () => {
  test("beside a bare board: a new pane on its right taking 40%, focused", () => {
    const s = openTicket(bare(), "A-1");
    expect(shape(s.root)).toBe(`row(B,${added(bare(), s).id})`);
    near(sizesOf(s.root), [BOARD_SHARE, 1 - BOARD_SHARE]);
    expect(findLeaf(s.root, s.focusedId!)?.content).toEqual({ kind: "ticket", ticketKey: "A-1", tab: "spec" });
    ok(s);
  });

  test("a tab is honoured for a new pane", () => {
    const s = openTicket(bare(), "A-1", "transcript");
    expect(leaves(s.root)[1]!.content).toMatchObject({ tab: "transcript" });
  });

  test("a second ticket replaces the ticket pane beside the board in place", () => {
    const one = openTicket(bare(), "A-1");
    const two = openTicket(one, "A-2");
    expect(shape(two.root)).toBe(shape(one.root));
    expect(leaves(two.root)[1]!.id).toBe(leaves(one.root)[1]!.id);
    expect(leaves(two.root)[1]!.content).toMatchObject({ ticketKey: "A-2", tab: "spec" });
    expect(two.focusedId).toBe(leaves(one.root)[1]!.id);
    ok(two);
  });

  test("an already-open ticket is focused, not duplicated; a given tab switches it, the same tab changes nothing", () => {
    const base = st(row("r", [board("B"), ticket("t1", "A-1"), ticket("t2", "A-2")], [0.5, 0.25, 0.25]));
    const a = openTicket(base, "A-2");
    expect(a.focusedId).toBe("t2");
    expect(leaves(a.root).map((l) => l.id)).toEqual(["B", "t1", "t2"]);
    expect(leaves(a.root)[2]!.content).toMatchObject({ tab: "spec" });
    const b = openTicket(a, "A-2", "details");
    expect(leaves(b.root)[2]!.content).toMatchObject({ tab: "details" });
    const c = openTicket(b, "A-2", "details");
    expect(c).toEqual(b);
    const d = openTicket(b, "A-2"); // no tab given keeps the tab
    expect(leaves(d.root)[2]!.content).toMatchObject({ tab: "details" });
  });

  test("zoom: kept when the revealed pane is the zoomed one, ended otherwise", () => {
    const base = st(row("r", [board("B"), ticket("t1", "A-1")]), "B", "t1");
    expect(openTicket(base, "A-1").zoomedId).toBe("t1");
    expect(openTicket(st(base.root, "B", "B"), "A-1").zoomedId).toBeNull();
    expect(openTicket(st(base.root, "B", "B"), "A-9").zoomedId).toBeNull(); // replaced in place, zoom was on the board
    expect(openTicket(st(bare().root, "B", "B"), "A-9").zoomedId).toBeNull(); // brand new pane
  });

  test("when the board is last in the row there's no pane beside it, so the new one opens to its right", () => {
    const s = openTicket(st(row("r", [ticket("t1", "A-1"), board("B")], [0.4, 0.6])), "A-2");
    expect(shape(s.root)).toMatch(/^row\(t1,B,p\d+\)$/);
    near(sizesOf(s.root), [0.4, 0.6 * 0.6, 0.6 * 0.4]);
    ok(s);
  });

  test("a non-ticket pane beside the board is not replaced", () => {
    const s = openTicket(st(row("r", [board("B"), term("x", "s")], [0.6, 0.4])), "A-1");
    expect(shape(s.root)).toMatch(/^row\(B,p\d+,x\)$/);
    expect(leaves(s.root).find((l) => l.id === "x")!.content.kind).toBe("terminal");
    near(sizesOf(s.root), [0.36, 0.24, 0.4]);
  });

  test("with the board nested in a column, the next row sibling up the path supplies the target", () => {
    const root = row("r", [col("c", [board("B"), term("x", "s")]), ticket("t1", "A-1")], [0.6, 0.4]);
    const s = openTicket(st(root), "A-2");
    expect(leaves(s.root).map((l) => l.id)).toEqual(["B", "x", "t1"]);
    expect(leaves(s.root)[2]!.content).toMatchObject({ ticketKey: "A-2" });
  });

  test("the pane beside the board is found inside a nested column of the next sibling", () => {
    const root = row("r", [board("B"), col("c", [term("x", "s"), ticket("t1", "A-1")])], [0.6, 0.4]);
    const s = openTicket(st(root), "A-2");
    expect(leaves(s.root).map((l) => l.id)).toEqual(["B", "x", "t1"]);
    expect(leaves(s.root)[2]!.content).toMatchObject({ ticketKey: "A-2" });
  });
});

describe("openTicketInNewSplit", () => {
  test("splits the ticket pane beside the board 50/50 to its right", () => {
    const s = openTicketInNewSplit(st(row("r", [board("B"), ticket("t1", "A-1")], [0.6, 0.4])), "A-2");
    expect(shape(s.root)).toMatch(/^row\(B,t1,p\d+\)$/);
    near(sizesOf(s.root), [0.6, 0.2, 0.2]);
    expect(s.focusedId).toBe(leaves(s.root)[2]!.id);
    ok(s);
  });
  test("an open ticket is only focused", () => {
    const base = st(row("r", [board("B"), ticket("t1", "A-1"), ticket("t2", "A-2")]));
    const s = openTicketInNewSplit(base, "A-2");
    expect(leaves(s.root)).toHaveLength(3);
    expect(s.focusedId).toBe("t2");
  });
  test("with no ticket pane beside the board it behaves like openTicket", () => {
    expect(shape(openTicketInNewSplit(bare(), "A-1").root)).toMatch(/^row\(B,p\d+\)$/);
  });
});

describe("openTicketAtRightEdge", () => {
  test("beside the bare board it takes the 40% a click would", () => {
    near(sizesOf(openTicketAtRightEdge(bare(), "A-1").root), [BOARD_SHARE, 1 - BOARD_SHARE]);
  });
  test("with other panes it takes an equal share and the rest shrink in proportion", () => {
    const s = openTicketAtRightEdge(st(row("r", [board("B"), ticket("t1", "A-1")], [0.6, 0.4])), "A-2");
    expect(shape(s.root)).toMatch(/^row\(B,t1,p\d+\)$/);
    near(sizesOf(s.root), [0.6 * (2 / 3), 0.4 * (2 / 3), 1 / 3]);
    expect(s.root.id).toBe("r"); // the row is kept, not rewrapped
  });
  test("a root that isn't a row is wrapped in one", () => {
    const s = openTicketAtRightEdge(st(col("c", [board("B"), term("x", "s")])), "A-1");
    expect(shape(s.root)).toMatch(/^row\(col\(B,x\),p\d+\)$/);
    near(sizesOf(s.root), [0.5, 0.5]);
    ok(s);
  });
  test("a bare board root is a leaf, wrapped with the 40% share even though it is not a row", () => {
    expect(shape(openTicketAtRightEdge(bare(), "A-1").root)).toMatch(/^row\(B,p\d+\)$/);
  });
  test("an open ticket is focused instead", () => {
    const base = st(row("r", [board("B"), ticket("t1", "A-1")]));
    expect(openTicketAtRightEdge(base, "A-1").focusedId).toBe("t1");
    expect(leaves(openTicketAtRightEdge(base, "A-1").root)).toHaveLength(2);
  });
  test("ends a zoom so the new pane shows", () => {
    expect(openTicketAtRightEdge(st(bare().root, "B", "B"), "A-1").zoomedId).toBeNull();
  });
});

describe("openTerminal / openCompose widths", () => {
  const sessions = (s: PaneState) => leaves(s.root).filter((l) => l.content.kind === "terminal").length;
  const content = { kind: "terminal", sessionId: "s1", cwd: "/w" } as const;

  test("without a workspace width the pane takes an equal share", () => {
    const base = st(row("r", [board("B"), ticket("t", "A-1")], [0.6, 0.4]));
    near(sizesOf(openTerminal(base, content).root), [0.6 * (2 / 3), 0.4 * (2 / 3), 1 / 3]);
    near(sizesOf(openTerminal(base, content, 0).root), [0.6 * (2 / 3), 0.4 * (2 / 3), 1 / 3]);
    near(sizesOf(openTerminal(base, content, -5).root), [0.6 * (2 / 3), 0.4 * (2 / 3), 1 / 3]);
  });

  test("a roomy workspace gives COMPOSE_WIDTH_PX", () => {
    const s = openTerminal(bare(), content, 4000);
    near(sizesOf(s.root), [1 - COMPOSE_WIDTH_PX / 4000, COMPOSE_WIDTH_PX / 4000]);
  });

  test("a narrow workspace gives what the others' minimums leave, never under the terminal's own minimum", () => {
    const w = PANE_MIN_WIDTH.board + 500;
    near(sizesOf(openTerminal(bare(), content, w).root), [1 - 500 / w, 500 / w]);
    const tight = PANE_MIN_WIDTH.board + 100;
    near(sizesOf(openTerminal(bare(), content, tight).root), [1 - PANE_MIN_WIDTH.terminal / tight, PANE_MIN_WIDTH.terminal / tight]);
  });

  test("the share is capped at 90%", () => {
    const s = openTerminal(bare(), content, 100);
    near(sizesOf(s.root), [0.1, 0.9]);
  });

  test("a terminal session already open is only focused; a second session adds a pane", () => {
    const one = openTerminal(bare(), content);
    expect(one.focusedId).toBe(leaves(one.root)[1]!.id);
    const again = openTerminal({ ...one, focusedId: null }, content);
    expect(sessions(again)).toBe(1);
    expect(again.focusedId).toBe(leaves(one.root)[1]!.id);
    expect(sessions(openTerminal(one, { ...content, sessionId: "s2" }))).toBe(2);
  });

  test("a New session uses its own minimum and focuses an open one with the same id", () => {
    const w = PANE_MIN_WIDTH.board + 100;
    near(sizesOf(openCompose(bare(), { kind: "compose", id: "n1" }, w).root), [1 - PANE_MIN_WIDTH.compose / w, PANE_MIN_WIDTH.compose / w]);
    const s = openCompose(bare(), { kind: "compose", id: "n1" });
    const again = openCompose({ ...s, focusedId: null }, { kind: "compose", id: "n1" });
    expect(leaves(again.root)).toHaveLength(2);
    expect(again.focusedId).toBe(leaves(s.root)[1]!.id);
  });

  test("openCompose defaults to a fresh New session each call", () => {
    const s = openCompose(openCompose(bare()));
    expect(leaves(s.root).filter((l) => l.content.kind === "compose")).toHaveLength(2);
    ok(s);
  });
});

describe("openFile", () => {
  const f = (path: string, extra: Partial<FileContent> = {}): FileContent => ({ kind: "file", root: { projectId: "pr" }, path, ...extra });
  const fileLeaves = (s: PaneState) => leaves(s.root).filter((l) => l.content.kind === "file");

  test("a new file opens on the far right, focused", () => {
    const s = openFile(bare(), f("a.ts", { startLine: 3 }));
    expect(fileLeaves(s)).toHaveLength(1);
    expect(fileLeaves(s)[0]!.content).toEqual(f("a.ts", { startLine: 3 }));
    expect(s.focusedId).toBe(fileLeaves(s)[0]!.id);
    ok(s);
  });

  test("line numbers are validated: non-integers, zero and a reversed or single-line end are dropped", () => {
    const lines = (c: Partial<FileContent>) => {
      const l = fileLeaves(openFile(bare(), f("a.ts", c)))[0]!.content as FileContent;
      return [l.startLine, l.endLine];
    };
    expect(lines({ startLine: 2, endLine: 5 })).toEqual([2, 5]);
    expect(lines({ startLine: 5, endLine: 5 })).toEqual([5, undefined]);
    expect(lines({ startLine: 5, endLine: 2 })).toEqual([5, undefined]);
    expect(lines({ startLine: 0, endLine: 9 })).toEqual([undefined, undefined]);
    expect(lines({ startLine: 1.5 })).toEqual([undefined, undefined]);
    expect(lines({ endLine: 9 })).toEqual([undefined, undefined]);
  });

  test("only the diff tab is kept on a new pane", () => {
    expect((fileLeaves(openFile(bare(), f("a", { tab: "diff" })))[0]!.content as FileContent).tab).toBe("diff");
    expect("tab" in fileLeaves(openFile(bare(), f("a", { tab: "file" })))[0]!.content).toBe(false);
  });

  test("an open file is focused and moved to the new lines (lines clear when none given)", () => {
    const base = st(row("r", [board("B"), file("f", "a.ts"), ticket("t", "A-1")]), "t");
    const withLines = openFile(base, f("a.ts", { startLine: 4 }));
    expect(fileLeaves(withLines)).toHaveLength(1);
    expect(withLines.focusedId).toBe("f");
    expect(findLeaf(withLines.root, "f")!.content).toMatchObject({ startLine: 4 });
    expect((findLeaf(openFile(withLines, f("a.ts")).root, "f")!.content as FileContent).startLine).toBeUndefined();
  });

  test("an open file's tab: lines force File, an explicit tab wins, otherwise it stays", () => {
    const diffBase = st(row("r", [board("B"), { ...file("f", "a.ts"), content: { ...f("a.ts"), tab: "diff" as const } }]));
    const tabOf = (s: PaneState) => (findLeaf(s.root, "f")!.content as FileContent).tab;
    expect(tabOf(openFile(diffBase, f("a.ts")))).toBe("diff");
    expect(tabOf(openFile(diffBase, f("a.ts", { startLine: 2 })))).toBeUndefined();
    expect(tabOf(openFile(diffBase, f("a.ts", { startLine: 2, tab: "diff" })))).toBe("diff");
    expect(tabOf(openFile(diffBase, f("a.ts", { tab: "file" })))).toBeUndefined();
  });

  test("a file from a ticket root is a different file from a project root of the same name", () => {
    const base = st(row("r", [file("f", "a.ts", { ticketKey: "A-1" }), board("B")]));
    expect(fileLeaves(openFile(base, f("a.ts")))).toHaveLength(2);
  });

  test("opened from a file pane, that pane shows the new file", () => {
    const base = st(row("r", [board("B"), file("f", "a.ts")]), "f");
    const s = openFile(base, f("b.ts"));
    expect(fileLeaves(s)).toHaveLength(1);
    expect((findLeaf(s.root, "f")!.content as FileContent).path).toBe("b.ts");
    expect(s.focusedId).toBe("f");
  });

  test("opened from a pane with a file pane right after it in a row, that pane is reused", () => {
    const base = st(row("r", [board("B"), ticket("t", "A-1"), file("f", "a.ts")]), "t");
    const s = openFile(base, f("b.ts"));
    expect(leaves(s.root)).toHaveLength(3);
    expect((findLeaf(s.root, "f")!.content as FileContent).path).toBe("b.ts");
  });

  test("a file pane before the origin, or in a column, is not reused", () => {
    const before = openFile(st(row("r", [file("f", "a.ts"), board("B"), ticket("t", "A-1")]), "t"), f("b.ts"));
    expect(fileLeaves(before)).toHaveLength(2);
    const stacked = openFile(st(row("r", [board("B"), col("c", [ticket("t", "A-1"), file("f", "a.ts")])]), "t"), f("b.ts"));
    expect(fileLeaves(stacked)).toHaveLength(2);
  });

  test("fromLeafId beats the focused pane", () => {
    const base = st(row("r", [board("B"), ticket("t", "A-1"), file("f", "a.ts"), ticket("u", "A-2"), file("g", "c.ts")]), "u");
    const s = openFile(base, f("b.ts"), "t");
    expect((findLeaf(s.root, "f")!.content as FileContent).path).toBe("b.ts");
    expect((findLeaf(s.root, "g")!.content as FileContent).path).toBe("c.ts");
  });

  test("a new file pane uses the file minimum for its share", () => {
    const w = PANE_MIN_WIDTH.board + 100;
    near(sizesOf(openFile(bare(), f("a"), null, w).root), [1 - PANE_MIN_WIDTH.file / w, PANE_MIN_WIDTH.file / w]);
  });
});

describe("setFileView", () => {
  const base = st(row("r", [board("B"), { ...file("f", "a.ts"), content: { kind: "file", root: { projectId: "pr" }, path: "a.ts", startLine: 2, endLine: 4 } as FileContent }, ticket("t", "A-1")]));
  const content = (s: PaneState) => findLeaf(s.root, "f")!.content as FileContent;

  test("a missing or non-file pane leaves the state alone", () => {
    expect(setFileView(base, "ghost", { tab: "diff" })).toBe(base);
    expect(setFileView(base, "t", { tab: "diff" })).toBe(base);
  });
  test("an unchanged view returns the same state", () => {
    expect(setFileView(base, "f", {})).toBe(base);
    expect(setFileView(base, "f", { tab: "file" })).toBe(base);
    expect(setFileView(base, "f", { lines: { startLine: 2, endLine: 4 } })).toBe(base);
  });
  test("switching to diff keeps the lines; back to file drops the tab key", () => {
    const d = setFileView(base, "f", { tab: "diff" });
    expect(content(d)).toMatchObject({ tab: "diff", startLine: 2, endLine: 4 });
    const back = setFileView(d, "f", { tab: "file" });
    expect("tab" in content(back)).toBe(false);
  });
  test("lines: null clears, new lines replace, an invalid range clears too", () => {
    expect(content(setFileView(base, "f", { lines: null }))).toEqual({ kind: "file", root: { projectId: "pr" }, path: "a.ts" });
    expect(content(setFileView(base, "f", { lines: { startLine: 9 } }))).toMatchObject({ startLine: 9 });
    expect(content(setFileView(base, "f", { lines: { startLine: 9 } })).endLine).toBeUndefined();
    expect(content(setFileView(base, "f", { lines: { startLine: 0 } })).startLine).toBeUndefined();
  });
});

describe("composeToTicket", () => {
  const base = st(row("r", [board("B"), compose("n", "n1"), ticket("t", "A-1")], [0.5, 0.3, 0.2]), "n");
  test("an unknown compose id changes nothing", () => {
    expect(composeToTicket(base, "nope", "A-9")).toBe(base);
  });
  test("the pane becomes the ticket in place: same id, size and focus", () => {
    const s = composeToTicket(base, "n1", "A-9", "details");
    expect(findLeaf(s.root, "n")!.content).toEqual({ kind: "ticket", ticketKey: "A-9", tab: "details" });
    near(sizesOf(s.root), [0.5, 0.3, 0.2]);
    expect(s.focusedId).toBe("n");
    expect(findLeaf(composeToTicket(base, "n1", "A-9").root, "n")!.content).toMatchObject({ tab: "spec" });
    ok(s);
  });
  test("if the ticket is open elsewhere the compose closes and, if it was focused, focus moves there", () => {
    const s = composeToTicket(base, "n1", "A-1");
    expect(leaves(s.root).map((l) => l.id)).toEqual(["B", "t"]);
    expect(s.focusedId).toBe("t");
    ok(s);
  });
  test("an unfocused compose closing leaves focus where it was", () => {
    const s = composeToTicket({ ...base, focusedId: "B" }, "n1", "A-1");
    expect(s.focusedId).toBe("B");
  });
});

describe("openCos", () => {
  test("beside a bare board: a pane on its right taking 40%, focused, on the chat", () => {
    const s = openCos(bare(), "all");
    expect(shape(s.root)).toBe(`row(B,${added(bare(), s).id})`);
    near(sizesOf(s.root), [BOARD_SHARE, 1 - BOARD_SHARE]);
    expect(findLeaf(s.root, s.focusedId!)?.content).toEqual({ kind: "cos", scope: "all", tab: "chat" });
    ok(s);
  });

  test("there is one chief pane: another scope reuses it, and the same scope keeps its tab", () => {
    const opened = openCos(bare(), "all");
    const inbox = setCosTab(opened, leaves(opened.root)[1]!.id, "inbox");
    const again = openCos(inbox, "all");
    expect(leaves(again.root).filter((l) => l.content.kind === "cos")).toHaveLength(1);
    expect(leaves(again.root)[1]!.content).toEqual({ kind: "cos", scope: "all", tab: "inbox" });
    const other = openCos(inbox, "group:g1");
    expect(leaves(other.root).filter((l) => l.content.kind === "cos")).toHaveLength(1);
    expect(leaves(other.root)[1]!.content).toEqual({ kind: "cos", scope: "group:g1", tab: "chat" });
    ok(other);
  });

  test("Escape closes it, like a ticket pane", () => {
    const s = openCos(bare(), "all");
    expect(leaves(escapePanes(s).root)).toHaveLength(1);
  });

  test("it can't be narrower than a ticket pane", () => {
    expect(PANE_MIN_WIDTH.cos).toBe(PANE_MIN_WIDTH.ticket);
  });
});
