import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyDrop, dropInStore, dropPreview, dropTargetAt, findLeaf, layoutPanes, resetPaneIds, type DragSource, type PaneContent, type PaneState,
} from "../../../app/src/renderer/state/paneModel";
import { board, col, invariantErrors, row, shape, sizesOf, st, store, term, ticket } from "./paneBuild";

beforeEach(() => resetPaneIds());

const ok = (s: PaneState) => expect(invariantErrors(s)).toEqual([]);
const content = (s: PaneState, id: string): PaneContent | undefined => findLeaf(s.root, id)?.content;
const base = (focused: string | null = "B", zoomed: string | null = null) =>
  st(row("r", [board("B"), ticket("a", "A-1"), col("c", [ticket("b", "A-2"), term("t", "s1")])], [0.5, 0.25, 0.25]), focused, zoomed);

describe("replace drops: new content", () => {
  test("a card not open yet shows in the target's slot, which keeps its id and size", () => {
    const s = applyDrop(base(), { kind: "ticket", ticketKey: "A-9" }, "a", "replace");
    expect(shape(s.root)).toBe("row(B,a,col(b,t))");
    expect(content(s, "a")).toEqual({ kind: "ticket", ticketKey: "A-9", tab: "spec" });
    expect(sizesOf(s.root)).toEqual([0.5, 0.25, 0.25]);
    expect(s.focusedId).toBe("a");
    ok(s);
  });
  test("a tab replaces the target with a torn-off pane", () => {
    const s = applyDrop(base(), { kind: "tab", ticketKey: "A-1", tab: "transcript" }, "t", "replace");
    expect(content(s, "t")).toMatchObject({ kind: "ticketTab", ticketKey: "A-1", tab: "transcript" });
    ok(s);
  });
  test("the board is never replaced", () => {
    const s = base();
    expect(applyDrop(s, { kind: "ticket", ticketKey: "A-9" }, "B", "replace")).toBe(s);
  });
  test("a ghost target does nothing", () => {
    const s = base();
    expect(applyDrop(s, { kind: "ticket", ticketKey: "A-9" }, "ghost", "replace")).toBe(s);
  });
});

describe("replace drops: content already open moves, it doesn't open twice", () => {
  test("a ticket open in another pane takes the target's slot with its own pane (same id), and its old slot closes", () => {
    const s = applyDrop(base(), { kind: "ticket", ticketKey: "A-2" }, "a", "replace");
    expect(shape(s.root)).toBe("row(B,b,t)");
    expect(content(s, "b")).toEqual({ kind: "ticket", ticketKey: "A-2", tab: "spec" });
    expect(findLeaf(s.root, "a")).toBeNull();
    expect(s.focusedId).toBe("b");
    ok(s);
  });
  test("a dragged pane takes the target's slot and the target closes", () => {
    const s = applyDrop(base(), { kind: "pane", leafId: "t" }, "a", "replace");
    expect(shape(s.root)).toBe("row(B,t,b)");
    expect(findLeaf(s.root, "a")).toBeNull();
    expect(s.focusedId).toBe("t");
    ok(s);
  });
  test("a pane dropped on itself, or the board dragged anywhere, does nothing", () => {
    const s = base();
    expect(applyDrop(s, { kind: "pane", leafId: "a" }, "a", "replace")).toBe(s);
    expect(applyDrop(s, { kind: "pane", leafId: "B" }, "a", "replace")).toBe(s);
  });
});

describe("replace drops: zoom and focus", () => {
  test("a zoomed target stays zoomed on what replaced it", () => {
    const fresh = applyDrop(base("a", "a"), { kind: "ticket", ticketKey: "A-9" }, "a", "replace");
    expect(fresh.zoomedId).toBe("a");
    const moved = applyDrop(base("a", "a"), { kind: "pane", leafId: "t" }, "a", "replace");
    expect(moved.zoomedId).toBe("t");
    expect(moved.focusedId).toBe("t");
    ok(moved);
  });
  test("an unzoomed drop leaves nothing zoomed", () => {
    expect(applyDrop(base("B", null), { kind: "pane", leafId: "t" }, "a", "replace").zoomedId).toBeNull();
  });
});

describe("replace drops: preview and hit test", () => {
  test("the preview is the target's whole box, not a half", () => {
    const s = base();
    const target = layoutPanes(s).leaves.find((b) => b.leaf.id === "a")!.rect;
    expect(dropPreview(s, { kind: "ticket", ticketKey: "A-9" }, "a", "replace")).toEqual(target);
    expect(dropPreview(s, { kind: "ticket", ticketKey: "A-9" }, "a", "right")!.w).toBeCloseTo(target.w / 2, 9);
  });
  test("no preview where the drop does nothing", () => {
    const s = base();
    expect(dropPreview(s, { kind: "pane", leafId: "a" }, "a", "replace")).toBeNull();
    expect(dropPreview(s, { kind: "ticket", ticketKey: "A-9" }, "B", "replace")).toBeNull();
  });
  test("dropTargetAt reports replace in a pane's middle and the nearest edge outside it", () => {
    const layout = layoutPanes(base());
    const a = layout.leaves.find((b) => b.leaf.id === "a")!.rect;
    expect(dropTargetAt(layout, a.x + a.w / 2, a.y + a.h / 2)).toMatchObject({ leafId: "a", zone: "replace" });
    expect(dropTargetAt(layout, a.x + a.w * 0.95, a.y + a.h / 2)).toMatchObject({ leafId: "a", zone: "right" });
    expect(dropTargetAt(layout, a.x + a.w / 2, a.y + a.h * 0.05)).toMatchObject({ leafId: "a", zone: "top" });
  });
});

describe("replace drops across the store", () => {
  const src = (s: DragSource) => s;
  test("a drop in a board scope replaces, and a pop-out scope is untouched", () => {
    const s = store({ p1: base() });
    const out = dropInStore(s, "p1", src({ kind: "ticket", ticketKey: "A-9" }), "a", "replace");
    expect(content(out.scopes.p1!, "a")).toMatchObject({ ticketKey: "A-9" });
    expect(dropInStore(s, "popout:w", src({ kind: "ticket", ticketKey: "A-9" }), "a", "replace")).toBe(s);
  });
  test("replacing the board or a pane with itself leaves the store alone", () => {
    const s = store({ p1: base() });
    expect(dropInStore(s, "p1", src({ kind: "ticket", ticketKey: "A-9" }), "B", "replace")).toBe(s);
    expect(dropInStore(s, "p1", src({ kind: "pane", leafId: "a" }), "a", "replace")).toBe(s);
  });
});
