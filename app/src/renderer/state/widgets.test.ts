import { describe, expect, test } from "bun:test";
import { widgetSignature } from "./widgets";

describe("widgetSignature", () => {
  const t = (key: string, status: string, extra: Partial<{ busy: boolean; title: string; updatedAt: number; draft: boolean }> = {}) => ({
    key, status, busy: false, title: "T", updatedAt: 1, ...extra,
  });

  test("ignores done tickets, drafts and order", () => {
    const a = widgetSignature([t("A-1", "in_progress"), t("A-2", "review")]);
    expect(widgetSignature([t("A-2", "review"), t("A-1", "in_progress"), t("A-3", "done"), t("A-4", "planning", { draft: true })])).toBe(a);
  });

  test("changes with a status, a run starting, a retitle or an update", () => {
    const base = widgetSignature([t("A-1", "in_progress")]);
    expect(widgetSignature([t("A-1", "blocked")])).not.toBe(base);
    expect(widgetSignature([t("A-1", "in_progress", { busy: true })])).not.toBe(base);
    expect(widgetSignature([t("A-1", "in_progress", { title: "New" })])).not.toBe(base);
    expect(widgetSignature([t("A-1", "in_progress", { updatedAt: 2 })])).not.toBe(base);
    // A ticket finishing leaves the widget too.
    expect(widgetSignature([t("A-1", "done")])).not.toBe(base);
  });
});
