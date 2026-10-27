import { describe, expect, test } from "bun:test";
import type { LabelInfo } from "@harness/shared";
import { LABELS_PAGE, labelSearchActive, labelSearchToggle, sidebarLabels } from "../../../app/src/renderer/state/sidebarLabels";

const label = (name: string, count: number): LabelInfo => ({ name, color: "red", createdAt: 0, lastUsedAt: 0, count });
const many = (n: number, count = 1) => Array.from({ length: n }, (_, i) => label(`L${i}`, count));

describe("sidebarLabels", () => {
  test("shows the first ten in collection order and counts what's left", () => {
    const r = sidebarLabels(many(25));
    expect(r.shown.map((l) => l.name)).toEqual(many(LABELS_PAGE).map((l) => l.name));
    expect(r.more).toBe(15);
  });
  test("a larger limit reveals more until none are left", () => {
    expect(sidebarLabels(many(25), 20)).toMatchObject({ more: 5 });
    const all = sidebarLabels(many(25), 30);
    expect(all.shown).toHaveLength(25);
    expect(all.more).toBe(0);
  });
  test("labels with count 0 are hidden and don't take a slot or count toward More", () => {
    const labels = [label("Idle", 0), ...many(11), label("Idle2", 0)];
    const r = sidebarLabels(labels);
    expect(r.shown).toHaveLength(10);
    expect(r.shown.some((l) => l.count === 0)).toBe(false);
    expect(r.more).toBe(1);
  });
  test("a label returns when its count rises above zero", () => {
    expect(sidebarLabels([label("A", 0)]).shown).toEqual([]);
    expect(sidebarLabels([label("A", 2)]).shown.map((l) => l.name)).toEqual(["A"]);
  });
});

describe("label search from the sidebar", () => {
  test("a click searches for the label, quoting a name with spaces", () => {
    expect(labelSearchToggle("", "Bugfix")).toBe("label:Bugfix");
    expect(labelSearchToggle("something else", "Release 1.2.3")).toBe('label:"Release 1.2.3"');
  });
  test("a second click clears it, without caring about case", () => {
    expect(labelSearchToggle("label:Bugfix", "bugfix")).toBe("");
    expect(labelSearchToggle('label:"Release 1.2.3" ', "Release 1.2.3")).toBe("");
  });
  test("a search with other words or labels is replaced, not cleared", () => {
    expect(labelSearchToggle("label:Bugfix widget", "Bugfix")).toBe("label:Bugfix");
    expect(labelSearchToggle("label:Bugfix label:Docs", "Bugfix")).toBe("label:Bugfix");
  });
  test("a label is active when any qualifier names it", () => {
    expect(labelSearchActive("label:Docs label:bugfix", "Bugfix")).toBe(true);
    expect(labelSearchActive("bugfix", "Bugfix")).toBe(false);
  });
});
