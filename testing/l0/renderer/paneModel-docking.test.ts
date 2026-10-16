import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyDrop, dropContent, dropPreview, dropTargetAt, layoutPanes, leaves, movePane, resetPaneIds, sourceContent, splitTarget, tabContent, type PaneContent, type PaneState,
} from "../../../app/src/renderer/state/paneModel";
import { board, col, findSplit, invariantErrors, row, shape, sizesOf, st, term, ticket, torn } from "./paneBuild";

beforeEach(() => resetPaneIds());

const near = (a: number[], b: number[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
};
const ok = (s: PaneState) => expect(invariantErrors(s)).toEqual([]);
const tk = (key: string, tab: "spec" | "details" = "spec"): PaneContent => ({ kind: "ticket", ticketKey: key, tab });
const rect = (r: { x: number; y: number; w: number; h: number } | null) => (r ? [r.x, r.y, r.w, r.h] : null);
const nearRect = (r: { x: number; y: number; w: number; h: number } | null, e: number[]) => {
  expect(r).not.toBeNull();
  near(rect(r)!, e);
};

describe("dropContent: new content", () => {
  const base = () => st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.5, 0.25, 0.25]), "B", "B");

  test("on a pane's right/left in a row, the new pane becomes a sibling taking half of that pane", () => {
    const right = dropContent(base(), "a", "right", tk("A-9"));
    expect(shape(right.root)).toMatch(/^row\(B,a,p\d+,b\)$/);
    near(sizesOf(right.root), [0.5, 0.125, 0.125, 0.25]);
    const left = dropContent(base(), "a", "left", tk("A-9"));
    expect(shape(left.root)).toMatch(/^row\(B,p\d+,a,b\)$/);
    near(sizesOf(left.root), [0.5, 0.125, 0.125, 0.25]);
    ok(right);
    ok(left);
  });

  test("on the top/bottom of a pane in a row, the pane is wrapped in a column", () => {
    const s = dropContent(base(), "a", "bottom", tk("A-9"));
    expect(shape(s.root)).toMatch(/^row\(B,col\(a,p\d+\),b\)$/);
    near(sizesOf(s.root), [0.5, 0.25, 0.25]);
    near(sizesOf(s.root.type === "split" ? (s.root.children[1] as never) : s.root), [0.5, 0.5]);
    const top = dropContent(base(), "a", "top", tk("A-9"));
    expect(shape(top.root)).toMatch(/^row\(B,col\(p\d+,a\),b\)$/);
  });

  test("docking against the board leaves it BOARD_SHARE of its space, the new pane 40%", () => {
    const s = dropContent(base(), "B", "right", tk("A-9"));
    near(sizesOf(s.root), [0.5 * 0.6, 0.5 * 0.4, 0.25, 0.25]);
    const l = dropContent(base(), "B", "left", tk("A-9"));
    near(sizesOf(l.root), [0.5 * 0.4, 0.5 * 0.6, 0.25, 0.25]);
  });

  test("a new pane is focused and the zoom ends", () => {
    const s = dropContent(base(), "a", "right", tk("A-9"));
    expect(s.zoomedId).toBeNull();
    expect(leaves(s.root).find((l) => l.id === s.focusedId)!.content).toEqual(tk("A-9"));
  });

  test("an unknown target changes nothing", () => {
    const s = base();
    expect(dropContent(s, "ghost", "right", tk("A-9"))).toBe(s);
    expect(dropContent(s, "r", "right", tk("A-9"))).toBe(s);
  });
});

describe("dropContent / movePane: existing panes", () => {
  const base = () => st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2"), ticket("c", "A-3")], [0.4, 0.3, 0.2, 0.1]), "B", "B");

  test("content already open moves with its pane instead of opening twice", () => {
    const s = dropContent(st(row("r", [board("B"), ticket("a", "A-1"), col("c", [ticket("b", "A-2"), term("x", "s")])])), "x", "bottom", tk("A-1"));
    expect(leaves(s.root).filter((l) => l.content.kind === "ticket" && l.content.ticketKey === "A-1")).toHaveLength(1);
    expect(s.focusedId).toBe("a");
    ok(s);
  });

  test("reordering within the pane's own row keeps every size with its pane", () => {
    const s = movePane(base(), "c", "a", "left");
    expect(shape(s.root)).toBe("row(B,c,a,b)");
    near(sizesOf(s.root), [0.4, 0.1, 0.3, 0.2]);
    expect(s.focusedId).toBe("c");
    expect(s.zoomedId).toBeNull();
    const after = movePane(base(), "a", "c", "right");
    expect(shape(after.root)).toBe("row(B,b,c,a)");
    near(sizesOf(after.root), [0.4, 0.2, 0.1, 0.3]);
    ok(s);
  });

  test("a reorder that changes nothing returns the same state", () => {
    const s = base();
    expect(movePane(s, "a", "B", "right")).toBe(s); // already right after the board
    expect(movePane(s, "c", "b", "right")).toBe(s);
    expect(movePane(s, "a", "a", "right")).toBe(s);
  });

  test("a pane dropped on a different axis re-docks: removed, then split with the target", () => {
    const s = movePane(base(), "a", "c", "bottom");
    expect(shape(s.root)).toBe("row(B,b,col(c,a))");
    near(sizesOf(s.root), [0.7, 0.2, 0.1]); // the board took a's share
    near(sizesOf(findSplit(s.root, (s.root as { children: { id: string }[] }).children[2]!.id)!), [0.5, 0.5]);
    expect(s.focusedId).toBe("a");
    ok(s);
  });

  test("a pane moved to a pane in another split splits that pane's space; the moved leaf keeps its id", () => {
    const s = movePane(st(row("r", [board("B"), ticket("a", "A-1"), col("c", [ticket("b", "A-2"), ticket("d", "A-4")])], [0.4, 0.3, 0.3])), "a", "d", "bottom");
    expect(shape(s.root)).toBe("row(B,col(b,d,a))");
    ok(s);
  });

  test("moving a pane onto the board takes the board's BOARD_SHARE split", () => {
    const s = movePane(st(row("r", [board("B"), ticket("a", "A-1"), col("c", [ticket("b", "A-2"), ticket("d", "A-4")])], [0.4, 0.3, 0.3])), "d", "B", "right");
    near(sizesOf(s.root), [0.4 * 0.6, 0.4 * 0.4, 0.3, 0.3]);
    expect(shape(s.root)).toBe("row(B,d,a,b)");
  });

  test("an unknown pane or target changes nothing", () => {
    const s = base();
    expect(movePane(s, "ghost", "a", "right")).toBe(s);
    expect(movePane(s, "a", "ghost", "right")).toBe(s);
  });

  test("a reorder with different content (a ticket moved and switched to another tab) swaps the content too", () => {
    const s = dropContent(base(), "c", "left", tk("A-1", "details"));
    expect(shape(s.root)).toBe("row(B,b,a,c)");
    near(sizesOf(s.root), [0.4, 0.2, 0.3, 0.1]);
    const a = leaves(s.root).find((l) => l.id === "a")!;
    expect(a.content).toEqual(tk("A-1", "details"));
  });
});

describe("sourceContent / applyDrop", () => {
  const base = st(row("r", [board("B"), ticket("a", "A-1", "details"), torn("g", "A-1", "transcript")]));
  test("a pane's own content, or null when it is gone", () => {
    expect(sourceContent(base, { kind: "pane", leafId: "a" })).toEqual(tk("A-1", "details"));
    expect(sourceContent(base, { kind: "pane", leafId: "ghost" })).toBeNull();
  });
  test("a ticket: the open pane's content (keeping its tab), else a new one on the Spec", () => {
    expect(sourceContent(base, { kind: "ticket", ticketKey: "A-1" })).toEqual(tk("A-1", "details"));
    expect(sourceContent(base, { kind: "ticket", ticketKey: "A-7" })).toEqual(tk("A-7", "spec"));
  });
  test("a tab: the torn-off pane's content if open, else a new torn-off content", () => {
    expect(sourceContent(base, { kind: "tab", ticketKey: "A-1", tab: "transcript" })).toEqual({ kind: "ticketTab", ticketKey: "A-1", tab: "transcript" });
    expect(sourceContent(base, { kind: "tab", ticketKey: "A-1", tab: "details" })).toEqual(tabContent({ ticketKey: "A-1", tab: "details" }));
    expect(sourceContent(base, { kind: "tab", ticketKey: "A-1", tab: "browser", browserTab: 2 })).toEqual({ kind: "ticketTab", ticketKey: "A-1", tab: "browser", browserTab: 2 });
  });
  test("applyDrop routes a pane to movePane and a tab to a torn-off pane", () => {
    const moved = applyDrop(st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")])), { kind: "pane", leafId: "b" }, "B", "right");
    expect(shape(moved.root)).toBe("row(B,b,a)");
    const tornOff = applyDrop(base, { kind: "tab", ticketKey: "A-1", tab: "details" }, "a", "right");
    expect(leaves(tornOff.root).some((l) => l.content.kind === "ticketTab" && l.content.tab === "details")).toBe(true);
    ok(tornOff);
  });
  test("a drop that does nothing returns the state itself", () => {
    expect(applyDrop(base, { kind: "pane", leafId: "a" }, "a", "left")).toBe(base);
    expect(applyDrop(base, { kind: "ticket", ticketKey: "A-9" }, "ghost", "left")).toBe(base);
  });
});

describe("dropTargetAt", () => {
  const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]));
  test("the pane under the point and its zone", () => {
    expect(dropTargetAt(layoutPanes(s), 0.9, 0.5)).toMatchObject({ leafId: "a", zone: "right" });
    expect(dropTargetAt(layoutPanes(s), 0.1, 0.5)).toMatchObject({ leafId: "B", zone: "left" });
  });
  test("outside the workspace is null", () => {
    expect(dropTargetAt(layoutPanes(s), 1.5, 0.5)).toBeNull();
  });
  test("hidden (zoomed-over) panes can't be targets", () => {
    const zoomed = layoutPanes({ ...s, zoomedId: "a" });
    expect(dropTargetAt(zoomed, 0.1, 0.5)).toMatchObject({ leafId: "a" });
  });
  test("a shared edge belongs to the earlier pane", () => {
    expect(dropTargetAt(layoutPanes(s), 0.5, 0.5)!.leafId).toBe("B");
  });
});

describe("dropPreview", () => {
  const base = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.5, 0.25, 0.25]));

  test("null when the drop would do nothing", () => {
    expect(dropPreview(base, { kind: "pane", leafId: "a" }, "a", "right")).toBeNull();
    expect(dropPreview(base, { kind: "pane", leafId: "a" }, "B", "right")).toBeNull();
    expect(dropPreview(base, { kind: "pane", leafId: "a" }, "ghost", "right")).toBeNull();
  });

  test("an ordinary split: half of the target on the zone side", () => {
    nearRect(dropPreview(base, { kind: "ticket", ticketKey: "A-9" }, "b", "right"), [0.875, 0, 0.125, 1]);
    nearRect(dropPreview(base, { kind: "ticket", ticketKey: "A-9" }, "b", "left"), [0.75, 0, 0.125, 1]);
    nearRect(dropPreview(base, { kind: "ticket", ticketKey: "A-9" }, "b", "top"), [0.75, 0, 0.25, 0.5]);
    nearRect(dropPreview(base, { kind: "ticket", ticketKey: "A-9" }, "b", "bottom"), [0.75, 0.5, 0.25, 0.5]);
  });

  test("against the board the new pane gets 40% of the board", () => {
    nearRect(dropPreview(base, { kind: "ticket", ticketKey: "A-9" }, "B", "right"), [0.3, 0, 0.2, 1]);
    nearRect(dropPreview(base, { kind: "ticket", ticketKey: "A-9" }, "B", "left"), [0, 0, 0.2, 1]);
  });

  test("a reorder within the row shows the dragged pane's own width, anchored at the target's edge", () => {
    nearRect(dropPreview(base, { kind: "pane", leafId: "a" }, "b", "right"), [0.75, 0, 0.25, 1]);
    nearRect(dropPreview(base, { kind: "pane", leafId: "b" }, "B", "left"), [0, 0, 0.25, 1]);
  });

  test("a reorder preview is clamped inside the row", () => {
    // dragging the 0.5-wide pane next to a narrow one at the row's end: it can't hang off the edge
    const s = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")], [0.2, 0.6, 0.2]));
    const r = dropPreview(s, { kind: "pane", leafId: "a" }, "b", "right")!;
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.x).toBeGreaterThanOrEqual(0);
  });

  test("column splits use the vertical axis", () => {
    const s = st(row("r", [board("B"), col("c", [ticket("a", "A-1"), ticket("b", "A-2")], [0.7, 0.3])], [0.5, 0.5]));
    nearRect(dropPreview(s, { kind: "pane", leafId: "a" }, "b", "bottom"), [0.5, 0.3, 0.5, 0.7]);
  });

  test("an already-open ticket dragged by its card previews as the reorder it will be", () => {
    nearRect(dropPreview(base, { kind: "ticket", ticketKey: "A-1" }, "b", "right"), [0.75, 0, 0.25, 1]);
  });

  test("an area clamps the layout the preview is drawn against", () => {
    const s = st(row("r", [board("B"), ticket("a", "A-1")], [0.9, 0.1]));
    const r = dropPreview(s, { kind: "ticket", ticketKey: "A-9" }, "a", "right", { width: 1000, height: 800 })!;
    // a is laid out at its 360px minimum (0.36), so half of it is 0.18
    near([r.w], [0.18]);
  });
});

describe("splitTarget", () => {
  const s = st(row("r", [board("B"), ticket("a", "A-1"), ticket("b", "A-2")]), "b");
  test("the origin pane, else the focused one, else the board", () => {
    expect(splitTarget(s, "a")).toBe("a");
    expect(splitTarget(s)).toBe("b");
    expect(splitTarget(s, "ghost")).toBe("b");
    expect(splitTarget({ ...s, focusedId: null })).toBe("B");
    expect(splitTarget({ ...s, focusedId: "ghost" })).toBe("B");
  });
  test("a pane already showing the ticket is skipped", () => {
    expect(splitTarget(s, "a", "A-1")).toBe("b");
    expect(splitTarget(s, "a", "A-2")).toBe("a");
    expect(splitTarget(s, "b", "A-2")).toBe("B");
    expect(splitTarget({ ...s, focusedId: "a" }, "a", "A-1")).toBe("B");
  });
  test("a non-ticket pane is never skipped for a ticket key", () => {
    expect(splitTarget(st(row("r", [board("B"), term("x", "s")]), "x"), null, "A-1")).toBe("x");
  });
});
