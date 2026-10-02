import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ALL_SCOPE } from "@harness/shared/state";
import {
  closedSessions,
  closePane,
  closePopoutPane,
  getPaneStore,
  getPanes,
  getPopoutPanes,
  leaves,
  mapScopes,
  PANES_KEY,
  parsePaneStore,
  popIn,
  popInPane,
  popOut,
  popOutPane,
  popoutScope,
  pruneTickets,
  reloadPanes,
  replaceContent,
  resetPaneIds,
  retainPopoutPanes,
  retainPopouts,
  serializePaneStore,
  updatePanes,
  type PaneLeaf,
  type PaneNode,
  type PaneState,
  type PaneStore,
} from "./panes";
import { formatRoute, parseRoute } from "./route";

const B: PaneLeaf = { type: "leaf", id: "B", content: { kind: "board" } };
const T = (key: string): PaneLeaf => ({ type: "leaf", id: key, content: { kind: "ticket", ticketKey: key, tab: "spec" } });
const Term = (id: string, sessionId = `t:${id}`): PaneLeaf => ({ type: "leaf", id, content: { kind: "terminal", sessionId, cwd: "~" } });
const C = (id: string): PaneLeaf => ({ type: "leaf", id, content: { kind: "compose", id } });
const row = (id: string, children: PaneNode[]): PaneNode => ({ type: "split", id, dir: "row", children, sizes: children.map(() => 1 / children.length) });
const st = (root: PaneNode, focusedId: string | null = null): PaneState => ({ root, focusedId, zoomedId: null });
const labels = (s: PaneState | null | undefined) =>
  s ? leaves(s.root).map((l) => (l.content.kind === "board" ? "board" : l.content.kind === "ticket" ? l.content.ticketKey : l.content.kind === "terminal" ? `$${l.content.sessionId}` : "+")) : null;

beforeEach(() => resetPaneIds());

describe("popOut", () => {
  const store: PaneStore = { scopes: { a: st(row("r", [B, T("A-1"), Term("t1")]), "A-1") } };

  test("moves the pane out of its board into a pop-out scope of just that pane, keeping its id", () => {
    const next = popOut(store, "a", "A-1", "w1");
    expect(labels(next.scopes.a)).toEqual(["board", "$t:t1"]);
    const out = next.scopes[popoutScope("w1")]!;
    expect(out.root).toEqual(T("A-1"));
    expect(out.focusedId).toBe("A-1");
  });

  test("a terminal's shell survives the move: no scope stops showing its session", () => {
    const next = popOut(store, "a", "t1", "w1");
    expect(labels(next.scopes[popoutScope("w1")])).toEqual(["$t:t1"]);
    expect(closedSessions(store, next)).toEqual([]);
    // Its window closing is what ends it.
    expect(closedSessions(next, retainPopouts(next, () => false))).toEqual(["t:t1"]);
  });

  test("the board, a New session, a missing pane, a pop-out's own pane and a taken id don't pop out", () => {
    const withCompose: PaneStore = { scopes: { a: st(row("r", [B, C("n1")])) } };
    expect(popOut(store, "a", "B", "w1")).toBe(store);
    expect(popOut(withCompose, "a", "n1", "w1")).toBe(withCompose);
    expect(popOut(store, "a", "nope", "w1")).toBe(store);
    expect(popOut(store, "nope", "A-1", "w1")).toBe(store);
    const once = popOut(store, "a", "A-1", "w1");
    expect(popOut(once, popoutScope("w1"), "A-1", "w2")).toBe(once);
    expect(popOut(once, "a", "t1", "w1")).toBe(once);
  });
});

describe("popIn", () => {
  const out = popOut({ scopes: { a: st(row("r", [B, T("A-1"), T("A-2")]), "A-2") } }, "a", "A-1", "w1");

  test("docks the pane beside the focused one, focused, and the pop-out goes", () => {
    const next = popIn(out, "w1", "a");
    expect(next.scopes[popoutScope("w1")]).toBeUndefined();
    expect(labels(next.scopes.a)).toEqual(["board", "A-2", "A-1"]);
    const back = next.scopes.a!;
    expect(leaves(back.root).find((l) => l.id === back.focusedId)?.content).toMatchObject({ ticketKey: "A-1" });
  });

  test("a ticket the board already has open is focused there, not opened twice", () => {
    const reopened: PaneStore = { scopes: { ...out.scopes, a: replaceContent(out.scopes.a!, "A-2", { kind: "ticket", ticketKey: "A-1", tab: "spec" }) } };
    const next = popIn(reopened, "w1", "a");
    expect(labels(next.scopes.a)).toEqual(["board", "A-1"]);
    expect(next.scopes[popoutScope("w1")]).toBeUndefined();
  });

  test("a board that isn't stored yet gets a bare board with the pane beside it", () => {
    const next = popIn(out, "w1", ALL_SCOPE);
    expect(labels(next.scopes[ALL_SCOPE])).toEqual(["board", "A-1"]);
  });

  test("an unknown pop-out, or a pop-out as the target, changes nothing", () => {
    expect(popIn(out, "w9", "a")).toBe(out);
    expect(popIn(out, "w1", popoutScope("w2"))).toBe(out);
  });
});

describe("pop-out scopes through the other operations", () => {
  test("a ticket deleted everywhere takes its pop-out with it", () => {
    const out = popOut({ scopes: { a: st(row("r", [B, T("A-1")])) } }, "a", "A-1", "w1");
    const next = mapScopes(out, (s) => pruneTickets(s, (k) => k !== "A-1"));
    expect(Object.keys(next.scopes)).toEqual(["a"]);
  });

  test("stored pop-outs read back as their one pane, and one with nothing left is dropped", () => {
    const out = popOut({ scopes: { a: st(row("r", [B, T("A-1")])) } }, "a", "A-1", "w1");
    const raw = JSON.parse(serializePaneStore(out));
    raw.scopes[popoutScope("w2")] = { root: B, focusedId: null, zoomedId: null };
    const back = parsePaneStore(JSON.stringify(raw));
    expect(labels(back.scopes[popoutScope("w1")])).toEqual(["A-1"]);
    expect(back.scopes[popoutScope("w2")]).toBeUndefined();
  });

  test("a stored pop-out whose shell another scope already shows is dropped (a shell has one pane)", () => {
    const raw = { scopes: { a: st(row("r", [B, Term("t1")])), [popoutScope("w1")]: st(Term("t2", "t:t1")) } };
    const back = parsePaneStore(JSON.stringify(raw));
    expect(back.scopes[popoutScope("w1")]).toBeUndefined();
    expect(labels(back.scopes.a)).toEqual(["board", "$t:t1"]);
  });
});

describe("pop-outs in the pane store (localStorage)", () => {
  const saved = (globalThis as { localStorage?: Storage }).localStorage;
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    reloadPanes();
    updatePanes("a", () => st(row("r", [B, T("A-1"), Term("t1")]), "A-1"));
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = saved;
    reloadPanes();
  });
  const stored = () => parsePaneStore(data.get(PANES_KEY));

  test("popping out and back in is one write each, and survives a reload", () => {
    expect(popOutPane("a", "A-1", "w1")).toBe(true);
    expect(labels(stored().scopes[popoutScope("w1")])).toEqual(["A-1"]);
    reloadPanes();
    expect(labels(getPopoutPanes("w1"))).toEqual(["A-1"]);
    popInPane("w1", "a");
    expect(getPopoutPanes("w1")).toBeNull();
    expect(labels(stored().scopes.a)).toEqual(["board", "$t:t1", "A-1"]);
  });

  test("a pane can't pop out twice", () => {
    expect(popOutPane("a", "A-1", "w1")).toBe(true);
    expect(popOutPane("a", "A-1", "w2")).toBe(false);
    expect(popOutPane("a", "B", "w2")).toBe(false);
  });

  test("navigating inside a pop-out keeps it one pane, with no board", () => {
    popOutPane("a", "A-1", "w1");
    updatePanes(popoutScope("w1"), (s) => replaceContent(s, "A-1", { kind: "ticket", ticketKey: "A-7", tab: "spec" }));
    expect(labels(getPopoutPanes("w1"))).toEqual(["A-7"]);
  });

  test("closing a pop-out's pane removes the pop-out; a gone pop-out isn't brought back as a board", () => {
    popOutPane("a", "t1", "w1");
    updatePanes(popoutScope("w1"), (s) => closePane(s, "t1"));
    expect(getPopoutPanes("w1")).toBeNull();
    expect(labels(getPanes(popoutScope("w1")))).toEqual(["board"]);
    updatePanes(popoutScope("w1"), (s) => s);
    updatePanes("a", (s) => s);
    expect(Object.keys(getPaneStore().scopes)).toEqual(["a"]);
    expect(Object.keys(stored().scopes)).toEqual(["a"]);
  });

  test("closing a pop-out's window, and the startup check against the open windows", () => {
    popOutPane("a", "A-1", "w1");
    popOutPane("a", "t1", "w2");
    closePopoutPane("w1");
    expect(Object.keys(stored().scopes).sort()).toEqual(["a", popoutScope("w2")]);
    retainPopoutPanes(new Set(["w9"]));
    expect(Object.keys(stored().scopes)).toEqual(["a"]);
  });
});

describe("pop-out route", () => {
  test("round-trips, and a route without a board falls back to All projects", () => {
    const r = { view: "popout", id: "w1", fromScope: "proj 1" } as const;
    expect(parseRoute(formatRoute(r))).toEqual(r);
    expect(parseRoute(formatRoute({ view: "popout", id: "w1", fromScope: ALL_SCOPE }))).toEqual({ view: "popout", id: "w1", fromScope: ALL_SCOPE });
    expect(parseRoute("#/popout/w1")).toEqual({ view: "popout", id: "w1", fromScope: ALL_SCOPE });
  });
});
