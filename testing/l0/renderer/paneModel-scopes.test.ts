import { beforeEach, describe, expect, test } from "bun:test";
import { ALL_SCOPE } from "@harness/shared/state";
import {
  bareBoardId, closedSessions, closePane, dropInStore, forgetProject, findLeaf, leaves, mapScopes, popIn, popOut, popoutPanes, popOutContent, popoutShowing, pruneTickets, resetPaneIds, retainPopouts,
  retainScopes, returnTab, terminalScopeOf, terminalSessions, tornOffTabs, withScope, type PaneContent, type PaneState, type PaneStore,
} from "../../../app/src/renderer/state/paneModel";
import { board, col, compose, file, invariantErrors, row, shape, sizesOf, st, store, term, ticket, torn } from "./paneBuild";

beforeEach(() => resetPaneIds());

const near = (a: readonly number[], b: readonly number[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
};
/** Every id across every scope is unique, each non-popout scope is valid and each popout has no board. */
const storeOk = (s: PaneStore) => {
  const ids: string[] = [];
  for (const [scope, state] of Object.entries(s.scopes)) {
    expect(invariantErrors(state, { popout: scope.startsWith("popout:") })).toEqual([]);
    const walk = (n: PaneState["root"]) => {
      ids.push(n.id);
      if (n.type === "split") n.children.forEach(walk);
    };
    walk(state.root);
  }
  expect(new Set(ids).size).toBe(ids.length);
};
const tk = (key: string, tab: "spec" | "transcript" | "details" | "activity" = "spec"): PaneContent => ({ kind: "ticket", ticketKey: key, tab });
const tab = (key: string, t: "transcript" | "browser" | "changes" | "details" | "spec", browserTab?: number): PaneContent =>
  ({ kind: "ticketTab", ticketKey: key, tab: t, ...(browserTab !== undefined ? { browserTab } : {}) }) as PaneContent;
const popoutOf = (leaf: ReturnType<typeof ticket>): PaneState => st(leaf, leaf.id);

describe("withScope", () => {
  const s = store({ p1: st(board("B")) });
  test("sets a scope, replacing any earlier one", () => {
    const next = withScope(s, "p2", st(board("C")));
    expect(Object.keys(next.scopes).sort()).toEqual(["p1", "p2"]);
    expect(withScope(s, "p1", st(board("D"))).scopes.p1!.root.id).toBe("D");
  });
  test("null removes it; removing or setting the same value is a no-op on the same store", () => {
    expect(withScope(s, "p1", null).scopes).toEqual({});
    expect(withScope(s, "nope", null)).toBe(s);
    expect(withScope(s, "p1", s.scopes.p1!)).toBe(s);
  });
  test("the original store is not mutated", () => {
    withScope(s, "p2", st(board("C")));
    withScope(s, "p1", null);
    expect(Object.keys(s.scopes)).toEqual(["p1"]);
  });
});

describe("popoutPanes", () => {
  test("a state that is already one non-board pane is returned as is", () => {
    const s = popoutOf(ticket("a", "A-1"));
    expect(popoutPanes(s)).toBe(s);
  });
  test("the board is taken out again, leaving the first other pane, focused, unzoomed", () => {
    const s = popoutPanes(st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")]), "b", "b"))!;
    expect(s).toEqual({ root: ticket("a", "A-1"), focusedId: "a", zoomedId: null });
  });
  test("nothing left means the scope should go", () => {
    expect(popoutPanes(st(board("B")))).toBeNull();
  });
  test("a pop-out holding two non-board panes keeps the first", () => {
    expect(popoutPanes(st(row("r", [ticket("a", "A-1"), ticket("b", "A-2")])))!.root.id).toBe("a");
  });
});

describe("popOut", () => {
  const base = () => store({ p1: st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.5, 0.25, 0.25]), "a") });

  test("the pane leaves the board (which takes its space) and becomes the pop-out's only pane, keeping its id", () => {
    const s = popOut(base(), "p1", "a", "w1");
    expect(shape(s.scopes.p1!.root)).toBe("row(B,b)");
    near(sizesOf(s.scopes.p1!.root), [0.75, 0.25]);
    expect(s.scopes["popout:w1"]).toEqual({ root: ticket("a", "A-1"), focusedId: "a", zoomedId: null });
    storeOk(s);
  });
  test("the board's focus moves off the popped pane", () => {
    expect(popOut(base(), "p1", "a", "w1").scopes.p1!.focusedId).toBe("b");
  });
  test("unchanged store when: no such scope or pane, the board, a New session, a pop-out as the source, or a taken id", () => {
    const s = store({ ...base().scopes, "popout:w9": popoutOf(ticket("z", "Z-1")), c: st(row("r2", [board("B2"), compose("n", "n1")])) });
    expect(popOut(s, "nope", "a", "w1")).toBe(s);
    expect(popOut(s, "p1", "ghost", "w1")).toBe(s);
    expect(popOut(s, "p1", "B", "w1")).toBe(s);
    expect(popOut(s, "c", "n", "w1")).toBe(s);
    expect(popOut(s, "popout:w9", "z", "w2")).toBe(s);
    expect(popOut(s, "p1", "a", "w9")).toBe(s);
  });
  test("a terminal pops out with its shell still in the store", () => {
    const s = store({ p1: st(row("r", [board("B"), term("x", "sess")])) });
    const out = popOut(s, "p1", "x", "w1");
    expect(closedSessions(s, out)).toEqual([]);
    expect(terminalScopeOf(out, "sess")).toBe("popout:w1");
  });
});

describe("popIn", () => {
  const popped = (extra: Record<string, PaneState> = {}) => store({ p1: st(row("r", [board("B"), ticket("x", "A-9")]), "x"), "popout:w1": popoutOf(ticket("a", "A-1", "details")), ...extra });

  test("the pane returns to the right of the focused pane, focused, and the window goes", () => {
    const s = popIn(popped(), "w1", "p1");
    expect(s.scopes["popout:w1"]).toBeUndefined();
    expect(shape(s.scopes.p1!.root)).toMatch(/^row\(B,x,p\d+\)$/);
    const back = leaves(s.scopes.p1!.root)[2]!;
    expect(back.content).toEqual(tk("A-1", "details"));
    expect(s.scopes.p1!.focusedId).toBe(back.id);
    storeOk(s);
  });
  test("with nothing focused it lands beside the board", () => {
    const s = popIn(store({ p1: st(row("r", [board("B"), ticket("x", "A-9")])), "popout:w1": popoutOf(ticket("a", "A-1")) }), "w1", "p1");
    expect(shape(s.scopes.p1!.root)).toMatch(/^row\(B,p\d+,x\)$/);
  });
  test("a scope with no stored panes starts from a bare board with the stable id", () => {
    const s = popIn(store({ "popout:w1": popoutOf(ticket("a", "A-1")) }), "w1", "p7");
    expect(leaves(s.scopes.p7!.root)[0]!.id).toBe(bareBoardId("p7"));
    expect(leaves(s.scopes.p7!.root)).toHaveLength(2);
  });
  test("a ticket the board already has open is focused there instead; the window still goes", () => {
    const s = popIn(store({ p1: st(row("r", [board("B"), ticket("x", "A-1")]), "B"), "popout:w1": popoutOf(ticket("a", "A-1")) }), "w1", "p1");
    expect(leaves(s.scopes.p1!.root)).toHaveLength(2);
    expect(s.scopes.p1!.focusedId).toBe("x");
    expect(s.scopes["popout:w1"]).toBeUndefined();
  });
  test("an unknown pop-out, an empty one, or a pop-out as destination is a no-op", () => {
    const s = popped({ "popout:w2": st(board("Q")) });
    expect(popIn(s, "nope", "p1")).toBe(s);
    expect(popIn(s, "w2", "p1")).toBe(s);
    expect(popIn(s, "w1", "popout:w2")).toBe(s);
  });
  test("round trip: pop out then in leaves the same ticket on the board", () => {
    const start = store({ p1: st(row("r", [board("B"), ticket("a", "A-1")]), "a") });
    const back = popIn(popOut(start, "p1", "a", "w1"), "w1", "p1");
    expect(leaves(back.scopes.p1!.root).map((l) => l.content)).toEqual([{ kind: "board" }, tk("A-1")]);
    expect(Object.keys(back.scopes)).toEqual(["p1"]);
  });
});

describe("tornOffTabs / popoutShowing", () => {
  const s = store({
    p1: st(row("r", [board("B"), ticket("t", "A-1"), torn("g", "A-1", "transcript"), torn("o", "A-2", "transcript")])),
    p2: st(row("r2", [board("B2"), torn("h", "A-1", "details")])),
    "popout:w1": popoutOf(torn("w", "A-1", "changes")),
    "popout:w2": popoutOf(torn("v", "A-1", "browser", 3)),
  });
  test("collects the board's own tab and every pop-out's, keyed by tornId, with where each is", () => {
    const m = tornOffTabs(s, "A-1", "p1");
    expect([...m.keys()].sort()).toEqual(["browser:3", "changes", "transcript"]);
    expect(m.get("transcript")).toMatchObject({ scope: "p1", leafId: "g", window: false });
    expect(m.get("changes")).toMatchObject({ scope: "popout:w1", leafId: "w", window: true });
  });
  test("another board's torn-off tabs don't count, and neither do other tickets'", () => {
    expect(tornOffTabs(s, "A-1", "p1").has("details")).toBe(false);
    expect(tornOffTabs(s, "A-1", "p2").has("details")).toBe(true);
    expect(tornOffTabs(s, "A-1", "p2").has("transcript")).toBe(false);
    expect([...tornOffTabs(s, "A-2", "p1").keys()]).toEqual(["transcript"]);
  });
  test("a board scope with no stored panes sees only the pop-outs", () => {
    expect([...tornOffTabs(s, "A-1", "never-opened").keys()].sort()).toEqual(["browser:3", "changes"]);
  });
  test("when a tab is torn off in the board and a window, the board's wins", () => {
    const both = store({ p1: st(row("r", [board("B"), torn("g", "A-1", "transcript")])), "popout:w": popoutOf(torn("w", "A-1", "transcript")) });
    expect(tornOffTabs(both, "A-1", "p1").get("transcript")!.scope).toBe("p1");
  });
  test("popoutShowing finds the window of a ticket or torn-off tab, never the board or a board scope", () => {
    expect(popoutShowing(s, tab("A-1", "changes"))?.scope).toBe("popout:w1");
    expect(popoutShowing(s, tab("A-1", "browser", 3))?.scope).toBe("popout:w2");
    expect(popoutShowing(s, tab("A-1", "browser", 4))).toBeNull();
    expect(popoutShowing(s, tab("A-1", "transcript"))).toBeNull(); // only torn off in a board
    expect(popoutShowing(s, { kind: "board" })).toBeNull();
    expect(popoutShowing(store({ "popout:w": popoutOf(ticket("a", "A-5")) }), tk("A-5"))?.leaf.id).toBe("a");
  });
});

describe("popOutContent", () => {
  const base = () => store({ p1: st(row("r", [board("B"), ticket("t", "A-1", "transcript"), ticket("u", "A-2")]), "t") });

  test("content open on the board moves out with its pane", () => {
    const s = popOutContent(base(), "p1", tk("A-2"), "w1");
    expect(s.scopes["popout:w1"]!.root.id).toBe("u");
    expect(leaves(s.scopes.p1!.root).map((l) => l.id)).toEqual(["B", "t"]);
    storeOk(s);
  });
  test("new content opens as a fresh pane whose id collides with nothing, in any scope", () => {
    resetPaneIds();
    const clash = store({ p1: st(row("r", [board("p1"), ticket("p2", "A-1")])), p2: st(board("p3")) });
    const s = popOutContent(clash, "p1", { kind: "terminal", sessionId: "s", cwd: "/" }, "w1");
    storeOk(s);
    expect(s.scopes["popout:w1"]!.root.type === "leaf" && s.scopes["popout:w1"]!.root.content.kind).toBe("terminal");
  });
  test("a pop-out is focused on its pane", () => {
    const s = popOutContent(base(), "p1", tk("A-7"), "w1");
    const p = s.scopes["popout:w1"]!;
    expect(p.focusedId).toBe(p.root.id);
  });
  test("a no-op for the board, a New session, a pop-out as source, a taken id, or content already in a window", () => {
    const s = store({ ...base().scopes, "popout:w9": popoutOf(ticket("z", "Z-1")) });
    expect(popOutContent(s, "p1", { kind: "board" }, "w1")).toBe(s);
    expect(popOutContent(s, "p1", { kind: "compose", id: "n" }, "w1")).toBe(s);
    expect(popOutContent(s, "popout:w9", tk("A-5"), "w1")).toBe(s);
    expect(popOutContent(s, "p1", tk("A-5"), "w9")).toBe(s);
    expect(popOutContent(s, "p1", tk("Z-1"), "w1")).toBe(s);
  });
  test("tearing off the tab a ticket pane shows moves that pane to the first tab that isn't torn off", () => {
    const s = popOutContent(base(), "p1", tab("A-1", "transcript"), "w1");
    expect(findLeaf(s.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "spec" });
    storeOk(s);
  });
  test("the fallback skips tabs that are already torn off", () => {
    const start = store({ p1: st(row("r", [board("B"), ticket("t", "A-1", "transcript"), torn("g", "A-1", "details")])) });
    const withSpec = popOutContent(popOutContent(start, "p1", tab("A-1", "spec"), "w0"), "p1", tab("A-1", "transcript"), "w1");
    expect(findLeaf(withSpec.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "activity" });
  });
  test("a ticket pane on another tab is left alone, as is one on a pinned browser tab", () => {
    const s = popOutContent(base(), "p1", tab("A-2", "details"), "w1");
    expect(findLeaf(s.scopes.p1!.root, "u")!.content).toMatchObject({ tab: "spec" });
    const b = popOutContent(store({ p1: st(row("r", [board("B"), ticket("t", "A-1", "browser")])) }), "p1", tab("A-1", "browser", 1), "w3");
    expect(findLeaf(b.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "browser" });
  });
  test("a ticket pane inside another pop-out window leaves the tab too", () => {
    const s = store({ p1: st(board("B")), "popout:w0": popoutOf(ticket("t", "A-1", "transcript")) });
    const out = popOutContent(s, "p1", tab("A-1", "transcript"), "w1");
    expect(findLeaf(out.scopes["popout:w0"]!.root, "t")!.content).toMatchObject({ tab: "spec" });
  });
  test("a sub-agent view on the Agents tab leaves when Agents is torn off", () => {
    const start = store({ p1: st(row("r", [board("B"), leaf2("t", { kind: "ticket", ticketKey: "A-1", tab: "agent:xyz" })])) });
    const out = popOutContent(start, "p1", { kind: "ticketTab", ticketKey: "A-1", tab: "agents" }, "w1");
    expect(findLeaf(out.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "spec" });
  });
});

function leaf2(id: string, content: PaneContent) {
  return { type: "leaf" as const, id, content };
}

describe("returnTab", () => {
  test("a pane torn off in the board closes and the ticket pane shows that tab again, focused", () => {
    const s = store({ p1: st(row("r", [board("B"), ticket("t", "A-1", "spec"), torn("g", "A-1", "transcript")]), "g") });
    const out = returnTab(s, "p1", "A-1", "transcript");
    expect(leaves(out.scopes.p1!.root).map((l) => l.id)).toEqual(["B", "t"]);
    expect(findLeaf(out.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "transcript" });
    expect(out.scopes.p1!.focusedId).toBe("t");
    storeOk(out);
  });
  test("a pop-out window closes", () => {
    const s = store({ p1: st(row("r", [board("B"), ticket("t", "A-1")])), "popout:w": popoutOf(torn("w", "A-1", "details")) });
    const out = returnTab(s, "p1", "A-1", "details");
    expect(Object.keys(out.scopes)).toEqual(["p1"]);
    expect(findLeaf(out.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "details" });
  });
  test("the ticket pane may live in another pop-out window, which is then focused", () => {
    const s = store({ p1: st(board("B")), "popout:a": popoutOf(ticket("t", "A-1")), "popout:b": popoutOf(torn("w", "A-1", "details")) });
    const out = returnTab(s, "p1", "A-1", "details");
    expect(findLeaf(out.scopes["popout:a"]!.root, "t")!.content).toMatchObject({ tab: "details" });
    expect(out.scopes["popout:b"]).toBeUndefined();
  });
  test("a pinned browser tab returns to the Browser tab", () => {
    const b = store({ p1: st(row("r", [board("B"), ticket("t", "A-1"), torn("g", "A-1", "browser", 2)])) });
    const out = returnTab(b, "p1", "A-1", "browser:2");
    expect(findLeaf(out.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "browser" });
  });
  test("with no ticket pane to return to, the torn-off pane still closes", () => {
    const s = store({ p1: st(row("r", [board("B"), torn("g", "A-1", "transcript")])) });
    expect(leaves(returnTab(s, "p1", "A-1", "transcript").scopes.p1!.root).map((l) => l.id)).toEqual(["B"]);
  });
  test("a tab that isn't torn off changes nothing", () => {
    const s = store({ p1: st(row("r", [board("B"), ticket("t", "A-1"), torn("g", "A-1", "transcript")])) });
    expect(returnTab(s, "p1", "A-1", "details")).toBe(s);
    expect(returnTab(s, "p1", "A-2", "transcript")).toBe(s);
    expect(returnTab(s, "p2", "A-1", "transcript")).toBe(s); // another board's tree is not on screen
  });
});

describe("dropInStore", () => {
  const base = () => store({ p1: st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.5, 0.25, 0.25])) });

  test("nothing happens in a pop-out scope, for a missing pane, or for a drop that does nothing", () => {
    const s = base();
    expect(dropInStore(s, "popout:w", { kind: "ticket", ticketKey: "A-9" }, "a", "right")).toBe(s);
    expect(dropInStore(s, "p1", { kind: "pane", leafId: "ghost" }, "a", "right")).toBe(s);
    expect(dropInStore(s, "p1", { kind: "pane", leafId: "a" }, "a", "right")).toBe(s);
    expect(dropInStore(s, "p1", { kind: "pane", leafId: "a" }, "B", "right")).toBe(s);
    expect(dropInStore(s, "p1", { kind: "ticket", ticketKey: "A-9" }, "ghost", "right")).toBe(s);
  });
  test("a pane drag reorders within the scope", () => {
    const out = dropInStore(base(), "p1", { kind: "pane", leafId: "b" }, "B", "right");
    expect(shape(out.scopes.p1!.root)).toBe("row(B,b,a)");
  });
  test("a ticket dragged in opens a pane on the zone", () => {
    const out = dropInStore(base(), "p1", { kind: "ticket", ticketKey: "A-9" }, "a", "bottom");
    expect(leaves(out.scopes.p1!.root)).toHaveLength(4);
    storeOk(out);
  });
  test("a ticket whose pane is in a pop-out window comes back from it, keeping its tab, and the window closes", () => {
    const s = store({ ...base().scopes, "popout:w": popoutOf(ticket("z", "Z-1", "details")) });
    const out = dropInStore(s, "p1", { kind: "ticket", ticketKey: "Z-1" }, "a", "right");
    expect(out.scopes["popout:w"]).toBeUndefined();
    const z = leaves(out.scopes.p1!.root).find((l) => l.content.kind === "ticket" && l.content.ticketKey === "Z-1")!;
    expect(z.content).toMatchObject({ tab: "details" });
    storeOk(out);
  });
  test("a pane open in the dropped-on board wins over the same ticket in a window", () => {
    const s = store({ ...base().scopes, "popout:w": popoutOf(ticket("z", "A-1")) });
    const out = dropInStore(s, "p1", { kind: "ticket", ticketKey: "A-1" }, "b", "right");
    expect(out.scopes["popout:w"]).toBeDefined();
    expect(leaves(out.scopes.p1!.root).filter((l) => l.content.kind === "ticket" && l.content.ticketKey === "A-1")).toHaveLength(1);
  });
  test("a scope with no stored panes is created from a bare board", () => {
    const out = dropInStore(store({}), "p5", { kind: "ticket", ticketKey: "A-1" }, bareBoardId("p5"), "right");
    expect(leaves(out.scopes.p5!.root)).toHaveLength(2);
    storeOk(out);
  });
  test("tearing a tab off moves the ticket pane off it", () => {
    const s = store({ p1: st(row("r", [board("B"), ticket("t", "A-1", "transcript")])) });
    const out = dropInStore(s, "p1", { kind: "tab", ticketKey: "A-1", tab: "transcript" }, "t", "right");
    expect(findLeaf(out.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "spec" });
    expect(leaves(out.scopes.p1!.root).some((l) => l.content.kind === "ticketTab")).toBe(true);
    storeOk(out);
  });
  test("a torn-off tab that lives in a window comes back from it when dropped on the board", () => {
    const s = store({ p1: st(row("r", [board("B"), ticket("t", "A-1")])), "popout:w": popoutOf(torn("w", "A-1", "details")) });
    const out = dropInStore(s, "p1", { kind: "tab", ticketKey: "A-1", tab: "details" }, "t", "right");
    expect(out.scopes["popout:w"]).toBeUndefined();
    expect(leaves(out.scopes.p1!.root).filter((l) => l.content.kind === "ticketTab")).toHaveLength(1);
  });
  test("a browser tab torn off leaves the ticket's tab alone", () => {
    const s = store({ p1: st(row("r", [board("B"), ticket("t", "A-1", "browser")])) });
    const out = dropInStore(s, "p1", { kind: "tab", ticketKey: "A-1", tab: "browser", browserTab: 1 }, "t", "right");
    expect(findLeaf(out.scopes.p1!.root, "t")!.content).toMatchObject({ tab: "browser" });
  });
});

describe("mapScopes / retain*", () => {
  const s = store({ p1: st(row("r", [board("B"), ticket("a", "A-1")])), "popout:w": popoutOf(ticket("z", "Z-1")), [ALL_SCOPE]: st(board("C")) });

  test("an identity function returns the same store, even with a pop-out present", () => {
    expect(mapScopes(s, (x) => x)).toBe(s);
  });
  test("a changed scope gives a new store; the others are the same objects", () => {
    const out = mapScopes(s, (x, scope) => (scope === "p1" ? closePane(x, "a") : x));
    expect(out).not.toBe(s);
    expect(out.scopes[ALL_SCOPE]).toBe(s.scopes[ALL_SCOPE]);
    expect(shape(out.scopes.p1!.root)).toBe("B");
  });
  test("a pop-out whose pane closed goes", () => {
    const out = mapScopes(s, (x) => pruneTickets(x, (k) => k !== "Z-1"));
    expect(Object.keys(out.scopes).sort()).toEqual(["*", "p1"]);
  });
  test("fn receives the scope name", () => {
    const seen: string[] = [];
    mapScopes(s, (x, scope) => (seen.push(scope), x));
    expect(seen.sort()).toEqual(["*", "p1", "popout:w"]);
  });

  test("retainScopes drops rejected scopes; the same store when none go", () => {
    expect(Object.keys(retainScopes(s, (k) => k !== "p1").scopes).sort()).toEqual(["*", "popout:w"]);
    expect(retainScopes(s, () => true)).toBe(s);
    expect(retainScopes(s, () => false).scopes).toEqual({});
  });
  test("retainPopouts judges only pop-outs, by their id", () => {
    expect(Object.keys(retainPopouts(s, () => false).scopes).sort()).toEqual(["*", "p1"]);
    expect(retainPopouts(s, (id) => id === "w")).toBe(s);
    const seen: string[] = [];
    retainPopouts(s, (id) => (seen.push(id), true));
    expect(seen).toEqual(["w"]);
  });
});

describe("terminals across scopes", () => {
  const s = store({
    p1: st(row("r", [board("B"), term("x", "s1"), term("y", "s2")])),
    p2: st(row("r2", [board("B2"), term("z", "s3")])),
    "popout:w": popoutOf(term("w", "s4")),
  });
  test("terminalSessions lists every open shell, terminalScopeOf finds its scope", () => {
    expect([...terminalSessions(s)].sort()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(terminalScopeOf(s, "s3")).toBe("p2");
    expect(terminalScopeOf(s, "s4")).toBe("popout:w");
    expect(terminalScopeOf(s, "nope")).toBeNull();
    expect(terminalSessions(store({}))).toEqual(new Set());
  });
  test("closedSessions: only shells no scope shows any more", () => {
    expect(closedSessions(s, s)).toEqual([]);
    expect(closedSessions(s, withScope(s, "p1", closePane(s.scopes.p1!, "x")))).toEqual(["s1"]);
    expect(closedSessions(s, withScope(s, "p2", null)).sort()).toEqual(["s3"]);
    expect(closedSessions(s, store({})).sort()).toEqual(["s1", "s2", "s3", "s4"]);
  });
  test("a shell that merely moved scope isn't closed", () => {
    const moved = withScope(withScope(s, "p1", closePane(s.scopes.p1!, "x")), "p2", st(row("r2", [board("B2"), term("z", "s3"), term("n", "s1")])));
    expect(closedSessions(s, moved)).toEqual([]);
  });
  test("a shell open in two scopes stays alive while either has it", () => {
    const dup = store({ a: st(row("r", [board("B"), term("x", "same")])), b: st(row("r2", [board("B2"), term("y", "same")])) });
    expect(closedSessions(dup, withScope(dup, "a", null))).toEqual([]);
  });
});

describe("forgetProject", () => {
  const s = store({
    pr: st(row("r", [board("B"), ticket("a", "ONE-1")])),
    other: st(row("r2", [board("B2"), ticket("b", "ONE-2"), ticket("c", "ONEX-1"), ticket("d", "TWO-1"), torn("g", "ONE-3"), file("f", "p", { ticketKey: "ONE-4" })])),
    "popout:w": popoutOf(ticket("z", "ONE-5")),
    "popout:v": popoutOf(ticket("y", "TWO-2")),
  });
  test("drops the project's board and closes its tickets everywhere (panes, torn-off tabs, files, pop-outs)", () => {
    const out = forgetProject(s, "pr", "ONE");
    expect(Object.keys(out.scopes).sort()).toEqual(["other", "popout:v"]);
    expect(leaves(out.scopes.other!.root).map((l) => l.id)).toEqual(["B2", "c", "d"]);
    storeOk(out);
  });
  test("the key match is on the 'KEY-' prefix, not any prefix", () => {
    expect(leaves(forgetProject(s, "pr", "ONE").scopes.other!.root).some((l) => l.id === "c")).toBe(true);
    expect(leaves(forgetProject(s, "pr", "ON").scopes.other!.root).some((l) => l.id === "b")).toBe(true);
  });
  test("with no key only the project's board goes", () => {
    const out = forgetProject(s, "pr", null);
    expect(Object.keys(out.scopes).sort()).toEqual(["other", "popout:v", "popout:w"]);
    expect(out.scopes.other).toBe(s.scopes.other!);
  });
  test("a project with no scope and a key nobody has changes nothing", () => {
    expect(forgetProject(s, "ghost", "NOPE")).toBe(s);
  });
});
