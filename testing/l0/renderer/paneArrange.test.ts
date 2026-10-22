import { describe, expect, test } from "bun:test";
import type { PaneAllowed, PaneOp } from "@harness/shared";
import { applyPaneOp, describeLayout, resolveRef, type ArrangeEnv } from "../../../app/src/renderer/state/paneArrange";
import { layoutPanes, leaves, type PaneState } from "../../../app/src/renderer/state/paneModel";
import { board, compose, file, invariantErrors, row, st, term, ticket, torn } from "./paneBuild";

const area = { width: 1600, height: 900 };
const allowed: PaneAllowed = { tickets: ["A-1", "A-2", "A-3"], terminals: ["t1", "t2"] };
const env = (over: Partial<ArrangeEnv> = {}): ArrangeEnv => ({
  allowed,
  area,
  terminal: (id) => (allowed.terminals.includes(id) ? { id, cwd: "/work" } : undefined),
  ...over,
});
const apply = (state: PaneState, op: PaneOp, e = env()) => {
  const r = applyPaneOp(state, op, e);
  if ("error" in r) return r;
  expect(invariantErrors(r.state)).toEqual([]);
  return r;
};
const open = (s: PaneState) => leaves(s.root).map((l) => (l.content.kind === "ticket" ? l.content.ticketKey : l.content.kind === "terminal" ? l.content.sessionId : l.content.kind));
const widthOf = (s: PaneState, ticketKey: string) => {
  const l = layoutPanes(s, area).leaves.find((b) => b.leaf.content.kind === "ticket" && b.leaf.content.ticketKey === ticketKey)!;
  return Math.round(l.rect.w * area.width);
};

describe("refs", () => {
  test("a ticket resolves by key and, with a tab, to that tab's torn-off pane before the ticket pane", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1"), torn("x", "A-1", "transcript")]));
    expect(resolveRef(s, { ticket: "A-1" })!.id).toBe("a");
    expect(resolveRef(s, { ticket: "A-1", tab: "transcript" })!.id).toBe("x");
    expect(resolveRef(s, { ticket: "A-1", tab: "details" })!.id).toBe("a");
    expect(resolveRef(s, { ticket: "A-9" })).toBeNull();
  });
});

describe("scope", () => {
  const s = st(row("r", [board("B"), ticket("a", "A-1"), ticket("o", "OTHER-1"), term("t", "t1"), term("u", "other-term"), file("f", "x.ts"), compose("c", "c1")]), "a");

  test("the layout names covered panes and only counts the rest", () => {
    const layout = describeLayout(s, allowed, area);
    expect(layout.panes.map((p) => p.pane)).toEqual([{ board: true }, { ticket: "A-1", tab: "spec" }, { terminal: "t1" }]);
    expect(layout.others).toBe(4);
    expect(JSON.stringify(layout)).not.toContain("OTHER-1");
    expect(JSON.stringify(layout)).not.toContain("other-term");
    expect(layout.panes.find((p) => "ticket" in p.pane)!.focused).toBe(true);
  });

  test("an op on a ticket or terminal outside the set is not found, whether or not it is open", () => {
    for (const pane of [{ ticket: "OTHER-1" }, { ticket: "NOPE-1" }, { terminal: "other-term" }] as const) {
      for (const op of ["open", "focus", "close"] as const) {
        const r = applyPaneOp(s, { op, pane }, env());
        expect(r).toHaveProperty("error");
        expect((r as { error: string }).error).toMatch(/^Unknown (ticket|terminal)/);
      }
    }
    expect(applyPaneOp(s, { op: "split", pane: { ticket: "A-2" }, target: { ticket: "OTHER-1" }, zone: "left" }, env())).toHaveProperty("error");
  });
});

describe("open and focus", () => {
  test("open shows a ticket beside the board and focuses it", () => {
    const r = apply(st(board("B"), "B"), { op: "open", pane: { ticket: "A-1", tab: "transcript" } }) as { state: PaneState; outcome: string };
    expect(open(r.state)).toEqual(["board", "A-1"]);
    expect(r.outcome).toBe("applied");
    expect(leaves(r.state.root).find((l) => l.content.kind === "ticket")!.content).toMatchObject({ tab: "transcript" });
  });

  test("opening what is open and focused changes nothing and says so; open on an unfocused one focuses it", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")]), "a");
    const again = apply(s, { op: "open", pane: { ticket: "A-1" } }) as { outcome: string; message: string };
    expect(again.outcome).toBe("unchanged");
    const other = apply(s, { op: "open", pane: { ticket: "A-2" } }) as { state: PaneState; outcome: string };
    expect(other.outcome).toBe("applied");
    expect(other.state.focusedId).toBe("b");
    expect(open(other.state)).toEqual(open(s));
  });

  test("a tab that doesn't exist is refused", () => {
    expect(applyPaneOp(st(board("B")), { op: "open", pane: { ticket: "A-1", tab: "nonsense" } }, env())).toEqual({ error: expect.stringMatching(/Unknown tab "nonsense"/) });
  });

  test("a terminal opens at the right edge; one this Mac doesn't know is refused", () => {
    const r = apply(st(board("B")), { op: "open", pane: { terminal: "t1" } }) as { state: PaneState };
    expect(open(r.state)).toEqual(["board", "t1"]);
    expect(applyPaneOp(st(board("B")), { op: "open", pane: { terminal: "t2" } }, env({ terminal: () => undefined }))).toEqual({ error: "Unknown terminal: t2" });
  });

  test("focus needs an open pane", () => {
    expect(applyPaneOp(st(board("B")), { op: "focus", pane: { ticket: "A-1" } }, env())).toEqual({ error: expect.stringMatching(/isn't open/) });
  });
});

describe("close", () => {
  test("closes an open pane; closing a missing one is a reported no-op; the board stays", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")]), "a");
    const closed = apply(s, { op: "close", pane: { ticket: "A-1" } }) as { state: PaneState; outcome: string };
    expect(open(closed.state)).toEqual(["board"]);
    const gone = apply(closed.state, { op: "close", pane: { ticket: "A-1" } }) as { outcome: string; message: string };
    expect(gone).toMatchObject({ outcome: "unchanged", message: expect.stringContaining("wasn't open") });
    expect(applyPaneOp(s, { op: "close", pane: { board: true } }, env())).toEqual({ error: "The board can't be closed." });
  });
});

describe("split and move", () => {
  const s = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")]), "a");

  test("split shows a closed ticket on the chosen side of a target, in a column for above/below", () => {
    const r = apply(s, { op: "split", pane: { ticket: "A-3" }, target: { ticket: "A-1" }, zone: "below" }) as { state: PaneState };
    const l = layoutPanes(r.state, area).leaves;
    const top = l.find((b) => b.leaf.content.kind === "ticket" && b.leaf.content.ticketKey === "A-1")!.rect;
    const bottom = l.find((b) => b.leaf.content.kind === "ticket" && b.leaf.content.ticketKey === "A-3")!.rect;
    expect(bottom.y).toBeGreaterThan(top.y);
    expect(bottom.x).toBeCloseTo(top.x);
  });

  test("split and move place an open pane to the left or right of the target, and repeating it is unchanged", () => {
    const r = apply(s, { op: "move", pane: { ticket: "A-2" }, target: { ticket: "A-1" }, zone: "left" }) as { state: PaneState };
    expect(open(r.state)).toEqual(["board", "A-2", "A-1"]);
    const again = apply(r.state, { op: "move", pane: { ticket: "A-2" }, target: { ticket: "A-1" }, zone: "left" }) as { outcome: string };
    expect(again.outcome).toBe("unchanged");
    const viaSplit = apply(s, { op: "split", pane: { ticket: "A-2" }, target: { ticket: "A-1" }, zone: "left" }) as { state: PaneState };
    expect(open(viaSplit.state)).toEqual(["board", "A-2", "A-1"]);
  });

  test("move refuses a pane that isn't open, a target that isn't open and a pane beside itself", () => {
    expect(applyPaneOp(s, { op: "move", pane: { ticket: "A-3" }, target: { ticket: "A-1" }, zone: "left" }, env())).toEqual({ error: expect.stringMatching(/isn't open/) });
    expect(applyPaneOp(s, { op: "split", pane: { ticket: "A-1" }, target: { ticket: "A-3" }, zone: "left" }, env())).toEqual({ error: expect.stringMatching(/isn't open, so there's nothing/) });
    expect(applyPaneOp(s, { op: "move", pane: { ticket: "A-1" }, target: { ticket: "A-1" }, zone: "left" }, env())).toEqual({ error: expect.stringMatching(/beside itself/) });
  });

  test("a pane can go beside the board", () => {
    const r = apply(s, { op: "move", pane: { ticket: "A-1" }, target: { board: true }, zone: "left" }) as { state: PaneState };
    expect(open(r.state)[0]).toBe("A-1");
  });
});

describe("resize", () => {
  const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]), "a");

  test("sets the width as a fraction of the window, the board taking the difference", () => {
    const r = apply(s, { op: "resize", pane: { ticket: "A-1" }, width: 0.25 }) as { state: PaneState; outcome: string };
    expect(r.outcome).toBe("applied");
    expect(widthOf(r.state, "A-1")).toBe(400);
  });

  test("resizing to the width it has is unchanged", () => {
    expect((apply(s, { op: "resize", pane: { ticket: "A-1" }, width: 0.5 }) as { outcome: string }).outcome).toBe("unchanged");
  });

  test("it acts on the named pane, not the focused one", () => {
    const two = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.4, 0.3, 0.3]), "b");
    const r = apply(two, { op: "resize", pane: { ticket: "A-1" }, width: 0.25 }) as { state: PaneState };
    expect(widthOf(r.state, "A-1")).toBe(400);
  });

  test("refuses out-of-range widths, the board, a pane that isn't open and a width that can't fit", () => {
    expect(applyPaneOp(s, { op: "resize", pane: { ticket: "A-1" }, width: 0.95 }, env())).toEqual({ error: expect.stringMatching(/between 0.1 and 0.9/) });
    expect(applyPaneOp(s, { op: "resize", pane: { board: true }, width: 0.3 }, env())).toHaveProperty("error");
    expect(applyPaneOp(s, { op: "resize", pane: { ticket: "A-2" }, width: 0.3 }, env())).toEqual({ error: expect.stringMatching(/isn't open/) });
    // 10% of 1600px is 160px, under a ticket's 360px minimum
    expect(applyPaneOp(s, { op: "resize", pane: { ticket: "A-1" }, width: 0.1 }, env())).toEqual({ error: expect.stringMatching(/minimum/) });
  });
});

describe("get_layout", () => {
  test("reads without changing anything", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")]), "a");
    const r = applyPaneOp(s, { op: "get_layout" }, env()) as { state: PaneState; outcome: string };
    expect(r.state).toBe(s);
    expect(r.outcome).toBe("unchanged");
  });
});
