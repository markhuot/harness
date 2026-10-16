import { describe, expect, test } from "bun:test";
import { widgetSignature } from "../../../app/src/renderer/state/widgets";

const t = (o: Partial<{ key: string; status: string; busy: boolean; title: string; updatedAt: number; draft: boolean }> = {}) => ({ key: "A-1", status: "in_progress", busy: false, title: "Fix", updatedAt: 1, ...o });

describe("widgetSignature", () => {
  test("an empty or all-done board is the empty string", () => {
    expect(widgetSignature([])).toBe("");
    expect(widgetSignature([t({ status: "done" })])).toBe("");
  });
  test("drafts are left out", () => {
    expect(widgetSignature([t({ draft: true })])).toBe("");
    expect(widgetSignature([t({ draft: false })])).not.toBe("");
  });
  test("order of tickets doesn't matter", () => {
    const a = t({ key: "A-1" });
    const b = t({ key: "B-2" });
    expect(widgetSignature([a, b])).toBe(widgetSignature([b, a]));
  });
  test.each([
    ["status", { status: "review" }],
    ["busy", { busy: true }],
    ["title", { title: "Fix it" }],
    ["updatedAt", { updatedAt: 2 }],
    ["key", { key: "A-2" }],
  ])("a change to %s changes the signature", (_n, change) => {
    expect(widgetSignature([t(change)])).not.toBe(widgetSignature([t()]));
  });
  test("a done ticket coming back, or a new one appearing, changes it", () => {
    expect(widgetSignature([t(), t({ key: "B-1" })])).not.toBe(widgetSignature([t()]));
  });
  test("accepts any iterable", () => {
    expect(widgetSignature(new Set([t()]))).toBe(widgetSignature([t()]));
  });
});
