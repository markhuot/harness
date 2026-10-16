import { beforeEach, describe, expect, test } from "bun:test";
import { ALL_SCOPE } from "@harness/shared/state";
import {
  defaultPanes, leaves, parsePanes, parsePaneStore, resetPaneIds, serializePaneStore, serializePanes, type PaneNode, type PaneState, type PaneStore,
} from "../../../app/src/renderer/state/paneModel";
import { board, col, compose, file, invariantErrors, row, shape, sizesOf, st, term, ticket, torn } from "./paneBuild";

beforeEach(() => resetPaneIds());

const near = (a: readonly number[], b: readonly number[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
};
const json = (v: unknown) => JSON.stringify(v);
const treeJson = (root: unknown, extra: Record<string, unknown> = {}) => json({ root, ...extra });
const rawLeaf = (id: string, content: unknown) => ({ type: "leaf" as const, id, content });
const rawBoard = (id = "B") => rawLeaf(id, { kind: "board" });
const parseOne = (content: unknown) => {
  const s = parsePanes(treeJson({ type: "split", id: "r", dir: "row", sizes: [0.5, 0.5], children: [rawBoard(), rawLeaf("x", content)] }));
  return leaves(s.root).filter((l) => l.content.kind !== "board").map((l) => l.content);
};

describe("parsePanes: input that isn't a stored tree", () => {
  test("missing, empty, corrupt, scalar and array input give just the board", () => {
    for (const raw of [null, undefined, "", "{nope", "7", "null", '"x"', "[]", "{}", '{"root":null}', '{"root":7}', '{"root":[]}']) {
      const s = parsePanes(raw);
      expect(s.root.type === "leaf" && s.root.content.kind === "board").toBe(true);
      expect(s.focusedId).toBeNull();
      expect(s.zoomedId).toBeNull();
    }
  });
  test("a tree whose every leaf is junk gives just the board", () => {
    const s = parsePanes(treeJson({ type: "split", id: "r", dir: "row", children: [rawLeaf("a", { kind: "mystery" }), 5, null], sizes: [1, 1, 1] }));
    expect(leaves(s.root).map((l) => l.content.kind)).toEqual(["board"]);
  });
});

describe("parsePanes: a good tree", () => {
  test("round-trips through serializePanes", () => {
    const original = st(row("r", [board("B"), col("c", [ticket("a", "A-1", "details"), term("x", "sess-1", "/w")], [0.3, 0.7]), file("f", "src/a.ts", { ticketKey: "A-1" })], [0.5, 0.3, 0.2]), "a", "x");
    expect(parsePanes(serializePanes(original))).toEqual(original);
  });
  test("focus and zoom are kept when they name a leaf, else null", () => {
    const root = row("r", [board("B"), ticket("a", "A-1")]);
    expect(parsePanes(treeJson(root, { focusedId: "a", zoomedId: "B" }))).toMatchObject({ focusedId: "a", zoomedId: "B" });
    expect(parsePanes(treeJson(root, { focusedId: "r", zoomedId: "ghost" }))).toMatchObject({ focusedId: null, zoomedId: null });
    expect(parsePanes(treeJson(root, { focusedId: 7, zoomedId: {} }))).toMatchObject({ focusedId: null, zoomedId: null });
  });
  test("broken invariants are repaired on the way in", () => {
    const s = parsePanes(treeJson(row("r", [ticket("a", "A-1"), ticket("b", "A-1")], [3, 1])));
    expect(invariantErrors(s)).toEqual([]);
    expect(leaves(s.root).filter((l) => l.content.kind === "ticket")).toHaveLength(1);
  });
});

describe("parsePanes: leaf contents", () => {
  test("board", () => {
    expect(parseOne({ kind: "board", extra: 1 })).toEqual([]); // second board dropped
  });
  test("a ticket needs a non-empty string key; the tab falls back to the Spec", () => {
    expect(parseOne({ kind: "ticket", ticketKey: "A-1", tab: "details" })).toEqual([{ kind: "ticket", ticketKey: "A-1", tab: "details" }]);
    expect(parseOne({ kind: "ticket", ticketKey: "A-1" })).toEqual([{ kind: "ticket", ticketKey: "A-1", tab: "spec" }]);
    expect(parseOne({ kind: "ticket", ticketKey: "A-1", tab: 7 })).toEqual([{ kind: "ticket", ticketKey: "A-1", tab: "spec" }]);
    expect(parseOne({ kind: "ticket", ticketKey: "A-1", tab: "nonsense" })).toEqual([{ kind: "ticket", ticketKey: "A-1", tab: "spec" }]);
    expect(parseOne({ kind: "ticket", ticketKey: "", tab: "spec" })).toEqual([]);
    expect(parseOne({ kind: "ticket", ticketKey: 5 })).toEqual([]);
  });
  test("renamed tabs map to their new names", () => {
    expect(parseOne({ kind: "ticket", ticketKey: "A-1", tab: "summaries" })).toEqual([{ kind: "ticket", ticketKey: "A-1", tab: "spec" }]);
    expect(parseOne({ kind: "ticket", ticketKey: "A-1", tab: "plugin:git:changes" })).toEqual([{ kind: "ticket", ticketKey: "A-1", tab: "changes" }]);
    expect(parseOne({ kind: "ticket", ticketKey: "A-1", tab: "plugin:x:y" })).toEqual([{ kind: "ticket", ticketKey: "A-1", tab: "plugin:x:y" }]);
  });
  test("a torn-off tab: valid tabs and the composer stay, an unknown tab drops the pane (it doesn't become the Spec)", () => {
    expect(parseOne({ kind: "ticketTab", ticketKey: "A-1", tab: "transcript" })).toEqual([{ kind: "ticketTab", ticketKey: "A-1", tab: "transcript" }]);
    expect(parseOne({ kind: "ticketTab", ticketKey: "A-1", tab: "composer" })).toEqual([{ kind: "ticketTab", ticketKey: "A-1", tab: "composer" }]);
    expect(parseOne({ kind: "ticketTab", ticketKey: "A-1", tab: "plugin:git:changes" })).toEqual([{ kind: "ticketTab", ticketKey: "A-1", tab: "changes" }]);
    expect(parseOne({ kind: "ticketTab", ticketKey: "A-1", tab: "bogus" })).toEqual([]);
    expect(parseOne({ kind: "ticketTab", ticketKey: "A-1" })).toEqual([]);
    expect(parseOne({ kind: "ticketTab", ticketKey: "", tab: "transcript" })).toEqual([]);
  });
  test("browserTab is kept only on the Browser tab and only as a non-negative integer", () => {
    const b = (browserTab: unknown, tab = "browser") => parseOne({ kind: "ticketTab", ticketKey: "A-1", tab, browserTab });
    expect(b(3)).toEqual([{ kind: "ticketTab", ticketKey: "A-1", tab: "browser", browserTab: 3 }]);
    expect(b(0)).toEqual([{ kind: "ticketTab", ticketKey: "A-1", tab: "browser", browserTab: 0 }]);
    for (const bad of [-1, 1.5, "2", null]) expect(b(bad)).toEqual([{ kind: "ticketTab", ticketKey: "A-1", tab: "browser" }]);
    expect(b(3, "transcript")).toEqual([{ kind: "ticketTab", ticketKey: "A-1", tab: "transcript" }]);
  });
  test("a terminal needs a valid session id and a cwd; an empty title is dropped", () => {
    expect(parseOne({ kind: "terminal", sessionId: "s-1.a:b_c", cwd: "/w", title: "vim" })).toEqual([{ kind: "terminal", sessionId: "s-1.a:b_c", cwd: "/w", title: "vim" }]);
    expect(parseOne({ kind: "terminal", sessionId: "s", cwd: "~", title: "" })).toEqual([{ kind: "terminal", sessionId: "s", cwd: "~" }]);
    expect(parseOne({ kind: "terminal", sessionId: "s", cwd: "~", title: 4 })).toEqual([{ kind: "terminal", sessionId: "s", cwd: "~" }]);
    for (const sessionId of ["", "has space", "slash/inside", "x".repeat(129), 5]) expect(parseOne({ kind: "terminal", sessionId, cwd: "/w" })).toEqual([]);
    expect(parseOne({ kind: "terminal", sessionId: "x".repeat(128), cwd: "/w" })).toHaveLength(1);
    expect(parseOne({ kind: "terminal", sessionId: "s", cwd: "" })).toEqual([]);
    expect(parseOne({ kind: "terminal", sessionId: "s" })).toEqual([]);
  });
  test("a file needs a path and a ticket or project root; lines are validated; only the diff tab is kept", () => {
    expect(parseOne({ kind: "file", path: "a.ts", root: { ticketKey: "A-1" }, startLine: 3, endLine: 8, tab: "diff" })).toEqual([{ kind: "file", root: { ticketKey: "A-1" }, path: "a.ts", startLine: 3, endLine: 8, tab: "diff" }]);
    expect(parseOne({ kind: "file", path: "a.ts", root: { projectId: "p" }, tab: "file" })).toEqual([{ kind: "file", root: { projectId: "p" }, path: "a.ts" }]);
    expect(parseOne({ kind: "file", path: "a.ts", root: { ticketKey: "A-1", projectId: "p" } })).toEqual([{ kind: "file", root: { ticketKey: "A-1" }, path: "a.ts" }]); // the ticket wins
    expect(parseOne({ kind: "file", path: "a.ts", root: { ticketKey: "", projectId: "p" } })).toEqual([{ kind: "file", root: { projectId: "p" }, path: "a.ts" }]);
    expect(parseOne({ kind: "file", path: "a.ts", root: { projectId: "p" }, startLine: 0, endLine: 5 })).toEqual([{ kind: "file", root: { projectId: "p" }, path: "a.ts" }]);
    expect(parseOne({ kind: "file", path: "a.ts", root: { projectId: "p" }, startLine: 5, endLine: 2 })).toEqual([{ kind: "file", root: { projectId: "p" }, path: "a.ts", startLine: 5 }]);
    expect(parseOne({ kind: "file", path: "a.ts", root: {} })).toEqual([]);
    expect(parseOne({ kind: "file", path: "a.ts", root: "p" })).toEqual([]);
    expect(parseOne({ kind: "file", path: "a.ts", root: [] })).toEqual([]);
    expect(parseOne({ kind: "file", path: "", root: { projectId: "p" } })).toEqual([]);
    expect(parseOne({ kind: "file", root: { projectId: "p" } })).toEqual([]);
  });
  test("a New session is never read back; unknown kinds, non-objects and missing content drop", () => {
    expect(parseOne({ kind: "compose", id: "n1" })).toEqual([]);
    expect(parseOne({ kind: "hologram" })).toEqual([]);
    expect(parseOne("ticket")).toEqual([]);
    expect(parseOne(null)).toEqual([]);
    expect(parseOne([])).toEqual([]);
  });
});

describe("parsePanes: splits", () => {
  const split = (o: Record<string, unknown>) => parsePanes(treeJson({ type: "split", id: "r", dir: "row", ...o }));
  test("an unknown direction, non-array children or an unknown node type are dropped", () => {
    expect(leaves(split({ dir: "diagonal", children: [rawBoard(), rawLeaf("a", { kind: "ticket", ticketKey: "A-1" })], sizes: [1, 1] }).root)).toHaveLength(1);
    expect(leaves(split({ children: "nope", sizes: [] }).root)).toHaveLength(1);
    expect(leaves(parsePanes(treeJson({ type: "pane", id: "x" })).root)).toHaveLength(1);
  });
  test("sizes of the wrong length or with non-numbers even out", () => {
    const kids = [rawBoard(), rawLeaf("a", { kind: "ticket", ticketKey: "A-1" }), rawLeaf("b", { kind: "ticket", ticketKey: "A-2" })];
    near(sizesOf(split({ children: kids, sizes: [1, 2] }).root), [1 / 3, 1 / 3, 1 / 3]);
    near(sizesOf(split({ children: kids }).root), [1 / 3, 1 / 3, 1 / 3]);
    near(sizesOf(split({ children: kids, sizes: [1, "x", 1] }).root), [1 / 3, 1 / 3, 1 / 3]);
    near(sizesOf(split({ children: kids, sizes: [1, null, 1] }).root), [1 / 3, 1 / 3, 1 / 3]);
    near(sizesOf(split({ children: kids, sizes: [0.5, 0.25, 0.25] }).root), [0.5, 0.25, 0.25]);
  });
  test("a dropped child takes its size entry with it", () => {
    const s = split({ children: [rawBoard(), rawLeaf("junk", { kind: "mystery" }), rawLeaf("a", { kind: "ticket", ticketKey: "A-1" })], sizes: [0.5, 0.3, 0.2] });
    near(sizesOf(s.root), [0.5 / 0.7, 0.2 / 0.7]);
  });
  test("a split left with one child collapses", () => {
    const s = split({ children: [rawBoard(), rawLeaf("junk", { kind: "mystery" })], sizes: [0.5, 0.5] });
    expect(shape(s.root)).toBe("B");
  });
  test("a missing or non-string id is re-minted", () => {
    const s = parsePanes(treeJson({ type: "split", dir: "row", sizes: [1, 1], children: [{ type: "leaf", content: { kind: "board" } }, { type: "leaf", id: 5, content: { kind: "ticket", ticketKey: "A-1" } }] }));
    expect(invariantErrors(s)).toEqual([]);
  });
  test("a tree nested past the depth limit can't be used to blow the stack; the usable part survives", () => {
    const nest = (depth: number): unknown => (depth === 0 ? rawBoard("deep") : { type: "split", id: `s${depth}`, dir: depth % 2 ? "row" : "column", sizes: [0.5, 0.5], children: [nest(depth - 1), rawLeaf(`t${depth}`, { kind: "ticket", ticketKey: `K-${depth}` })] });
    const shallow = parsePanes(treeJson(nest(10)));
    expect(leaves(shallow.root)).toHaveLength(11);
    const deep = parsePanes(treeJson(nest(200)));
    expect(invariantErrors(deep)).toEqual([]);
    expect(leaves(deep.root).length).toBeLessThan(201);
    expect(leaves(deep.root).some((l) => l.content.kind === "board")).toBe(true);
  });
});

describe("serializePanes", () => {
  test("New session panes aren't stored and their space goes where closing would send it", () => {
    const s = st(row("r", [board("B"), compose("n", "n1"), ticket("a", "A-1")], [0.5, 0.3, 0.2]), "n", "n");
    const out = JSON.parse(serializePanes(s)) as PaneState;
    expect(shape(out.root as PaneNode)).toBe("row(B,a)");
    near(sizesOf(out.root as PaneNode), [0.8, 0.2]);
    expect(out.focusedId).toBeNull();
    expect(out.zoomedId).toBeNull();
  });
  test("focus and zoom on a surviving pane are kept", () => {
    const s = st(row("r", [board("B"), compose("n", "n1"), ticket("a", "A-1")]), "a", "B");
    expect(JSON.parse(serializePanes(s))).toMatchObject({ focusedId: "a", zoomedId: "B" });
  });
  test("a state with no New session serializes as it is", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.6, 0.4]), "a");
    expect(JSON.parse(serializePanes(s))).toEqual(JSON.parse(JSON.stringify(s)));
  });
  test("several New sessions all go, and a lone board survives them", () => {
    const s = st(row("r", [board("B"), compose("n", "n1"), compose("m", "n2")]), "m");
    expect(shape(JSON.parse(serializePanes(s)).root)).toBe("B");
  });
});

describe("parsePaneStore", () => {
  const scoped = (scopes: Record<string, unknown>) => json({ scopes });
  const tree = (root: unknown, extra: Record<string, unknown> = {}) => ({ root, ...extra });

  test("missing, corrupt and shapeless input is an empty store", () => {
    for (const raw of [null, undefined, "", "{nope", "7", "null", "[]", "{}", '{"scopes":7}', '{"scopes":[]}', '{"scopes":null}']) expect(parsePaneStore(raw)).toEqual({ scopes: {} });
  });

  test("reads each scope's tree", () => {
    const s = parsePaneStore(scoped({ p1: tree(row("r", [board("B"), ticket("a", "A-1")]), { focusedId: "a" }), [ALL_SCOPE]: tree(board("B2")) }));
    expect(Object.keys(s.scopes).sort()).toEqual(["*", "p1"]);
    expect(s.scopes.p1!.focusedId).toBe("a");
  });

  test("the single tree from before per-board layouts becomes the All projects scope, projects start bare", () => {
    const s = parsePaneStore(json(tree(row("r", [board("B"), ticket("a", "A-1")]), { focusedId: "a" })));
    expect(Object.keys(s.scopes)).toEqual([ALL_SCOPE]);
    expect(s.scopes[ALL_SCOPE]!.focusedId).toBe("a");
  });

  test("when both shapes are present, scopes win", () => {
    const s = parsePaneStore(json({ root: board("B"), scopes: { p1: tree(board("B2")) } }));
    expect(Object.keys(s.scopes)).toEqual(["p1"]);
  });

  test("an entry that doesn't parse is dropped and the others stay; so is an empty scope name", () => {
    const s = parsePaneStore(scoped({ bad: 7, worse: { root: 5 }, arr: [], "": tree(board("B")), good: tree(board("B3")) }));
    expect(Object.keys(s.scopes)).toEqual(["good"]);
  });

  test("ids are unique across scopes: the first scope keeps its ids", () => {
    const s = parsePaneStore(scoped({ a: tree(row("r", [board("x"), ticket("y", "A-1")])), b: tree(row("r", [board("x"), ticket("y", "B-1")])) }));
    const ids = Object.values(s.scopes).flatMap((st2) => [st2.root.id, ...leaves(st2.root).map((l) => l.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(leaves(s.scopes.a!.root).map((l) => l.id)).toEqual(["x", "y"]);
    for (const st2 of Object.values(s.scopes)) expect(invariantErrors(st2)).toEqual([]);
  });

  test("a terminal session is kept in the first scope only; the rest of the scope stays", () => {
    const t = (id: string) => rawLeaf(id, { kind: "terminal", sessionId: "shared", cwd: "/w" });
    const s = parsePaneStore(scoped({ a: tree({ type: "split", id: "r1", dir: "row", sizes: [1, 1], children: [rawBoard("b1"), t("t1")] }), b: tree({ type: "split", id: "r2", dir: "row", sizes: [1, 1], children: [rawBoard("b2"), t("t2")] }) }));
    expect(leaves(s.scopes.a!.root).map((l) => l.content.kind)).toEqual(["board", "terminal"]);
    expect(leaves(s.scopes.b!.root).map((l) => l.content.kind)).toEqual(["board"]);
  });

  test("the id sequence moves past every stored id", () => {
    parsePaneStore(scoped({ a: tree(row("r", [board("p41"), ticket("p7", "A-1")])) }));
    expect(defaultPanes().root.id).toBe("p42");
  });

  test("a popout scope keeps only its one non-board pane (no board)", () => {
    const s = parsePaneStore(scoped({ "popout:w1": tree(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")])) }));
    const p = s.scopes["popout:w1"]!;
    expect(p.root.type).toBe("leaf");
    expect(p.root.type === "leaf" && p.root.content).toMatchObject({ ticketKey: "A-1" });
    expect(p.focusedId).toBe(p.root.id);
    expect(invariantErrors(p, { popout: true })).toEqual([]);
  });

  test("a popout scope with nothing to show is dropped", () => {
    const s = parsePaneStore(scoped({ "popout:w1": tree(board("B")), "popout:w2": tree(ticket("a", "A-1")) }));
    expect(Object.keys(s.scopes)).toEqual(["popout:w2"]);
  });

  test("a New session in a stored scope is not read back", () => {
    const s = parsePaneStore(scoped({ a: tree({ type: "split", id: "r", dir: "row", sizes: [1, 1], children: [rawBoard(), rawLeaf("n", { kind: "compose", id: "n1" })] }) }));
    expect(leaves(s.scopes.a!.root)).toHaveLength(1);
  });
});

describe("serializePaneStore", () => {
  test("round-trips, with New sessions stripped from every scope", () => {
    const store: PaneStore = { scopes: { p1: st(row("r", [board("B"), ticket("a", "A-1"), compose("n", "n1")], [0.5, 0.3, 0.2]), "a"), [ALL_SCOPE]: st(board("C")) } };
    const back = parsePaneStore(serializePaneStore(store));
    expect(shape(back.scopes.p1!.root)).toBe("row(B,a)");
    near(sizesOf(back.scopes.p1!.root), [0.7, 0.3]);
    expect(back.scopes[ALL_SCOPE]).toEqual(store.scopes[ALL_SCOPE]!);
    expect(JSON.stringify(JSON.parse(serializePaneStore(store)))).not.toContain("compose");
  });
  test("an empty store", () => {
    expect(parsePaneStore(serializePaneStore({ scopes: {} }))).toEqual({ scopes: {} });
  });
  test("a pop-out scope survives the round trip", () => {
    const store: PaneStore = { scopes: { "popout:w": st(ticket("a", "A-1"), "a") } };
    expect(parsePaneStore(serializePaneStore(store))).toEqual(store);
  });
  test("a pinned browser tab survives the round trip", () => {
    const store: PaneStore = { scopes: { p: st(row("r", [board("B"), torn("g", "A-1", "browser", 2)])) } };
    expect(parsePaneStore(serializePaneStore(store)).scopes.p).toEqual(store.scopes.p!);
  });
});
