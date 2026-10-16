import { beforeEach, describe, expect, test } from "bun:test";
import {
  boardLeaf, bareBoardId, canPopOut, composeLeafById, COMPOSER_TAB, cwdName, defaultPanes, fileKey, fileLeafByKey, fileRootTicket, findLeaf, focusedTicket, isPopoutScope, leaves,
  minSize, newComposeContent, paneLabel, paneTicket, PANE_MIN_HEIGHT, PANE_MIN_WIDTH, popoutIdOf, popoutScope, resetPaneIds, seedPaneIds, tabContent, terminalContent, terminalLeafBySession,
  ticketLeafByKey, tornId, tornKey, tornLeafByKey, tornTabLabel, zoneAt, type PaneContent,
} from "../../../app/src/renderer/state/paneModel";
import { board, col, compose, file, row, st, term, ticket, torn } from "./paneBuild";

beforeEach(() => resetPaneIds());

describe("finders", () => {
  const root = row("r", [board("B"), col("c", [ticket("t1", "A-1"), term("x", "s1"), torn("tt", "A-1", "transcript")]), file("f", "src/a.ts"), compose("n", "n9")]);

  test("leaves are depth first, first child first", () => {
    expect(leaves(root).map((l) => l.id)).toEqual(["B", "t1", "x", "tt", "f", "n"]);
  });
  test("each finder hits its kind and misses otherwise", () => {
    expect(findLeaf(root, "x")?.id).toBe("x");
    expect(findLeaf(root, "c")).toBeNull(); // a split id is not a leaf
    expect(boardLeaf(root)?.id).toBe("B");
    expect(ticketLeafByKey(root, "A-1")?.id).toBe("t1");
    expect(ticketLeafByKey(root, "A-2")).toBeNull();
    expect(terminalLeafBySession(root, "s1")?.id).toBe("x");
    expect(terminalLeafBySession(root, "t1")).toBeNull();
    expect(composeLeafById(root, "n9")?.id).toBe("n");
    expect(fileLeafByKey(root, fileKey({ root: { projectId: "pr" }, path: "src/a.ts" }))?.id).toBe("f");
    expect(fileLeafByKey(root, fileKey({ root: { ticketKey: "pr" }, path: "src/a.ts" }))).toBeNull();
    expect(tornLeafByKey(root, tornKey({ ticketKey: "A-1", tab: "transcript" }))?.id).toBe("tt");
  });
  test("boardLeaf is null without a board", () => {
    expect(boardLeaf(ticket("t", "A-1"))).toBeNull();
  });
});

describe("fileKey", () => {
  test("ticket roots and project roots with the same name differ; path matters", () => {
    const k = (root: { ticketKey: string } | { projectId: string }, path = "a") => fileKey({ root, path });
    expect(k({ ticketKey: "x" })).not.toBe(k({ projectId: "x" }));
    expect(k({ projectId: "x" }, "a")).not.toBe(k({ projectId: "x" }, "b"));
    expect(k({ projectId: "x" })).toBe(k({ projectId: "x" }));
  });
  test("fileRootTicket is the ticket for ticket roots, null for project roots", () => {
    expect(fileRootTicket({ kind: "file", root: { ticketKey: "A-1" }, path: "p" })).toBe("A-1");
    expect(fileRootTicket({ kind: "file", root: { projectId: "A" }, path: "p" })).toBeNull();
  });
});

describe("tornId / tornKey / tornTabLabel", () => {
  test("a pinned browser tab wins over the tab", () => {
    expect(tornId({ tab: "browser", browserTab: 3 })).toBe("browser:3");
    expect(tornId({ tab: "browser", browserTab: 0 })).toBe("browser:0");
  });
  test("a torn-off Browser without a pin is just the browser tab", () => {
    expect(tornId({ tab: "browser" })).toBe("browser");
  });
  test("the composer, a sub-agent transcript (the Agents strip entry) and plain tabs", () => {
    expect(tornId({ tab: COMPOSER_TAB })).toBe("composer");
    expect(tornId({ tab: "agent:abc" })).toBe("agents");
    expect(tornId({ tab: "agents" })).toBe("agents");
    expect(tornId({ tab: "transcript" })).toBe("transcript");
  });
  test("tornKey pairs ticket and id, so two tickets' same tab differ and an agent equals agents", () => {
    expect(tornKey({ ticketKey: "A-1", tab: "agent:x" })).toBe(tornKey({ ticketKey: "A-1", tab: "agents" }));
    expect(tornKey({ ticketKey: "A-1", tab: "details" })).not.toBe(tornKey({ ticketKey: "A-2", tab: "details" }));
  });
  test("labels: composer, changes, browser tab, built-in, plugin, sub-agent, unknown", () => {
    expect(tornTabLabel({ tab: COMPOSER_TAB })).toBe("Composer");
    expect(tornTabLabel({ tab: "changes" })).toBe("Changes");
    expect(tornTabLabel({ tab: "browser", browserTab: 2 })).toBe("Browser tab");
    expect(tornTabLabel({ tab: "browser" })).toBe("Browser");
    expect(tornTabLabel({ tab: "transcript" })).toBe("Transcript");
    expect(tornTabLabel({ tab: "plugin:git:diffs" })).toBe("diffs");
    expect(tornTabLabel({ tab: "agent:abc" })).toBe("Agent");
    expect(tornTabLabel({ tab: "toString" as never })).toBe("toString"); // not read off Object.prototype
  });
});

describe("paneLabel / cwdName", () => {
  const label = (c: PaneContent) => paneLabel(c);
  test("every kind", () => {
    expect(label({ kind: "board" })).toBe("the board");
    expect(label({ kind: "ticket", ticketKey: "A-1", tab: "spec" })).toBe("A-1");
    expect(label({ kind: "ticketTab", ticketKey: "A-1", tab: "transcript" })).toBe("A-1 · Transcript");
    expect(label({ kind: "compose", id: "n1" })).toBe("New session");
  });
  test("file: the last path component, the whole path when it ends in a slash", () => {
    expect(label({ kind: "file", root: { projectId: "p" }, path: "src/deep/a.ts" })).toBe("a.ts");
    expect(label({ kind: "file", root: { projectId: "p" }, path: "a.ts" })).toBe("a.ts");
    expect(label({ kind: "file", root: { projectId: "p" }, path: "src/dir/" })).toBe("src/dir/");
  });
  test("terminal: its title, else its folder", () => {
    expect(label({ kind: "terminal", sessionId: "s", cwd: "/a/b", title: "vim" })).toBe("vim");
    expect(label({ kind: "terminal", sessionId: "s", cwd: "/a/b", title: "" })).toBe("b");
    expect(label({ kind: "terminal", sessionId: "s", cwd: "/a/b" })).toBe("b");
  });
  test("cwdName handles trailing slashes, home and root", () => {
    expect(cwdName("/a/b/")).toBe("b");
    expect(cwdName("/a/b///")).toBe("b");
    expect(cwdName("~")).toBe("~");
    expect(cwdName("~/code")).toBe("code");
    expect(cwdName("/")).toBe("/");
    expect(cwdName("")).toBe("~");
    expect(cwdName("name")).toBe("name");
  });
});

describe("paneTicket / focusedTicket", () => {
  test("paneTicket per kind", () => {
    expect(paneTicket({ kind: "ticket", ticketKey: "A-1", tab: "spec" })).toBe("A-1");
    expect(paneTicket({ kind: "ticketTab", ticketKey: "A-2", tab: "details" })).toBe("A-2");
    expect(paneTicket({ kind: "file", root: { ticketKey: "A-3" }, path: "p" })).toBe("A-3");
    expect(paneTicket({ kind: "file", root: { projectId: "A" }, path: "p" })).toBeNull();
    expect(paneTicket({ kind: "board" })).toBeNull();
    expect(paneTicket({ kind: "terminal", sessionId: "s", cwd: "/" })).toBeNull();
  });
  test("focusedTicket: nothing focused, board focused, a missing id", () => {
    const root = row("r", [board("B"), ticket("t", "A-1", "details")]);
    expect(focusedTicket(st(root))).toBeNull();
    expect(focusedTicket(st(root, "B"))).toBeNull();
    expect(focusedTicket(st(root, "ghost"))).toBeNull();
  });
  test("a focused ticket pane gives its tab", () => {
    expect(focusedTicket(st(row("r", [board("B"), ticket("t", "A-1", "details")]), "t"))).toEqual({ ticketKey: "A-1", tab: "details" });
  });
  test("a focused torn-off tab stands for its ticket pane's tab, or the Spec when there's no pane", () => {
    const withPane = st(row("r", [board("B"), ticket("t", "A-1", "activity"), torn("x", "A-1", "transcript")]), "x");
    expect(focusedTicket(withPane)).toEqual({ ticketKey: "A-1", tab: "activity" });
    const without = st(row("r", [board("B"), torn("x", "A-1", "transcript")]), "x");
    expect(focusedTicket(without)).toEqual({ ticketKey: "A-1", tab: "spec" });
  });
});

describe("content constructors", () => {
  test("terminalContent keeps a title only when non-empty", () => {
    expect(terminalContent({ id: "s", cwd: "/x", title: "t" })).toEqual({ kind: "terminal", sessionId: "s", cwd: "/x", title: "t" });
    expect("title" in terminalContent({ id: "s", cwd: "/x", title: "" })).toBe(false);
    expect("title" in terminalContent({ id: "s", cwd: "/x" })).toBe(false);
  });
  test("newComposeContent mints distinct ids and presets a project only when given", () => {
    const a = newComposeContent();
    const b = newComposeContent("p1");
    expect(a.id).not.toBe(b.id);
    expect("projectId" in a).toBe(false);
    expect(b.projectId).toBe("p1");
  });
  test("tabContent pins a browserTab only to the Browser tab", () => {
    expect(tabContent({ ticketKey: "A-1", tab: "browser", browserTab: 2 })).toEqual({ kind: "ticketTab", ticketKey: "A-1", tab: "browser", browserTab: 2 });
    expect("browserTab" in tabContent({ ticketKey: "A-1", tab: "transcript", browserTab: 2 })).toBe(false);
    expect("browserTab" in tabContent({ ticketKey: "A-1", tab: "browser" })).toBe(false);
    expect(tabContent({ ticketKey: "A-1", tab: "browser", browserTab: 0 }).browserTab).toBe(0);
  });
});

describe("pop-out scope names", () => {
  test("prefix round-trips and only popout: scopes match", () => {
    expect(popoutScope("w1")).toBe("popout:w1");
    expect(popoutIdOf(popoutScope("w1"))).toBe("w1");
    expect(isPopoutScope("popout:w1")).toBe(true);
    expect(isPopoutScope("*")).toBe(false);
    expect(isPopoutScope("xpopout:w")).toBe(false);
  });
  test("canPopOut: not the board or a New session", () => {
    expect(canPopOut({ kind: "board" })).toBe(false);
    expect(canPopOut({ kind: "compose", id: "n" })).toBe(false);
    expect(canPopOut({ kind: "ticket", ticketKey: "A-1", tab: "spec" })).toBe(true);
    expect(canPopOut({ kind: "terminal", sessionId: "s", cwd: "/" })).toBe(true);
    expect(canPopOut({ kind: "file", root: { projectId: "p" }, path: "a" })).toBe(true);
    expect(canPopOut({ kind: "ticketTab", ticketKey: "A", tab: "details" })).toBe(true);
  });
  test("bareBoardId is stable per scope", () => {
    expect(bareBoardId("p1")).toBe(bareBoardId("p1"));
    expect(bareBoardId("p1")).not.toBe(bareBoardId("p2"));
  });
});

describe("ids", () => {
  test("defaultPanes is the board alone with a fresh id, or the id given", () => {
    const a = defaultPanes();
    const b = defaultPanes();
    expect(a.root.type === "leaf" && a.root.content.kind === "board").toBe(true);
    expect(a.root.id).not.toBe(b.root.id);
    expect(defaultPanes("mine").root.id).toBe("mine");
    expect(a.focusedId).toBeNull();
    expect(a.zoomedId).toBeNull();
  });
  test("resetPaneIds restarts the sequence", () => {
    const first = defaultPanes().root.id;
    resetPaneIds();
    expect(defaultPanes().root.id).toBe(first);
  });
  test("seedPaneIds moves the sequence past the highest stored p<N> and ignores other ids", () => {
    seedPaneIds(["p7", "p3", "b:scope", "px9", "p", "p2x"]);
    expect(defaultPanes().root.id).toBe("p8");
    seedPaneIds(["p2"]); // never moves back
    expect(defaultPanes().root.id).toBe("p9");
  });
});

describe("minSize", () => {
  test("a leaf needs its kind's width in a row, the shared height in a column", () => {
    expect(minSize(board(), "row")).toBe(PANE_MIN_WIDTH.board);
    expect(minSize(ticket("t", "A-1"), "row")).toBe(PANE_MIN_WIDTH.ticket);
    expect(minSize(term("x", "s"), "row")).toBe(PANE_MIN_WIDTH.terminal);
    expect(minSize(board(), "column")).toBe(PANE_MIN_HEIGHT);
  });
  test("a split along the axis sums; across it takes the largest", () => {
    const r = row("r", [board("B"), ticket("t", "A-1")]);
    expect(minSize(r, "row")).toBe(PANE_MIN_WIDTH.board + PANE_MIN_WIDTH.ticket);
    expect(minSize(r, "column")).toBe(PANE_MIN_HEIGHT);
    const c = col("c", [board("B"), ticket("t", "A-1")]);
    expect(minSize(c, "column")).toBe(2 * PANE_MIN_HEIGHT);
    expect(minSize(c, "row")).toBe(Math.max(PANE_MIN_WIDTH.board, PANE_MIN_WIDTH.ticket));
    const nested = row("r", [board("B"), col("c", [ticket("a", "A-1"), term("b", "s")])]);
    expect(minSize(nested, "row")).toBe(PANE_MIN_WIDTH.board + Math.max(PANE_MIN_WIDTH.ticket, PANE_MIN_WIDTH.terminal));
    expect(minSize(nested, "column")).toBe(Math.max(PANE_MIN_HEIGHT, 2 * PANE_MIN_HEIGHT));
  });
});

describe("zoneAt", () => {
  const r = { x: 0, y: 0, w: 1, h: 1 };
  test("the nearest edge wins", () => {
    expect(zoneAt(r, 0.05, 0.5)).toBe("left");
    expect(zoneAt(r, 0.95, 0.5)).toBe("right");
    expect(zoneAt(r, 0.5, 0.05)).toBe("top");
    expect(zoneAt(r, 0.5, 0.95)).toBe("bottom");
  });
  test("ties (centre, diagonals) go left/right, centre to right", () => {
    expect(zoneAt(r, 0.5, 0.5)).toBe("right");
    expect(zoneAt(r, 0.25, 0.25)).toBe("left"); // top-left diagonal
    expect(zoneAt(r, 0.75, 0.75)).toBe("right"); // bottom-right diagonal
    expect(zoneAt(r, 0.75, 0.25)).toBe("right"); // top-right diagonal
    expect(zoneAt(r, 0.25, 0.75)).toBe("left"); // bottom-left diagonal
  });
  test("measured in the rect's own proportions", () => {
    const wide = { x: 0, y: 0, w: 1, h: 0.1 };
    expect(zoneAt(wide, 0.5, 0.01)).toBe("top"); // 10% of the height from the top, 50% from the sides
    expect(zoneAt({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 0.55, 0.75)).toBe("left");
  });
  test("edges count as inside; outside and empty rects are null", () => {
    expect(zoneAt(r, 0, 0)).not.toBeNull();
    expect(zoneAt(r, 1, 1)).not.toBeNull();
    expect(zoneAt(r, 1.01, 0.5)).toBeNull();
    expect(zoneAt(r, -0.01, 0.5)).toBeNull();
    expect(zoneAt(r, 0.5, 1.01)).toBeNull();
    expect(zoneAt({ x: 0, y: 0, w: 0, h: 1 }, 0, 0.5)).toBeNull();
    expect(zoneAt({ x: 0, y: 0, w: 1, h: -1 }, 0.5, 0.5)).toBeNull();
    expect(zoneAt(r, Number.NaN, 0.5)).toBeNull();
  });
});
