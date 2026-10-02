import { describe, expect, test } from "bun:test";
import type { BrowserState } from "@harness/shared";
import { confirmsClose, confirmsNewTab, confirmsSwitch, frameIsForView, tabLabel, tabTooltip } from "./browserTabs";

const tab = (id: number) => ({ id, url: "about:blank", title: "", loading: false });
const st = (tabId: number, open: number[]): BrowserState => ({ sessionId: "s", tabId, url: "about:blank", title: "", loading: false, tabs: open.map(tab) });

describe("tabLabel", () => {
  test("the title wins over the URL", () => {
    expect(tabLabel({ title: "Dashboard", url: "http://localhost:3000/admin" })).toBe("Dashboard");
  });

  test("an untitled page falls back to its host, port included", () => {
    expect(tabLabel({ title: "  ", url: "http://localhost:3000/admin?x=1" })).toBe("localhost:3000");
  });

  test("a blank page is a new tab", () => {
    expect(tabLabel({ title: "", url: "about:blank" })).toBe("New tab");
    expect(tabLabel({ title: "", url: "" })).toBe("New tab");
  });

  test("a URL without a host, or no URL at all, shows as typed", () => {
    expect(tabLabel({ title: "", url: "data:text/html,hi" })).toBe("data:text/html,hi");
    expect(tabLabel({ title: "", url: "not a url" })).toBe("not a url");
  });
});

describe("tabTooltip", () => {
  test("adds the URL only when the label isn't it, and a line for a suspended tab", () => {
    expect(tabTooltip({ title: "Docs", url: "https://x.test/docs" })).toBe("Docs\nhttps://x.test/docs");
    expect(tabTooltip({ title: "", url: "not a url" })).toBe("not a url");
    expect(tabTooltip({ title: "Docs", url: "https://x.test/docs", suspended: true })).toBe(
      "Docs\nhttps://x.test/docs\nSuspended to save memory. Reloads when you open it.",
    );
    expect(tabTooltip({ title: "Docs", url: "https://x.test/docs", suspended: false })).not.toContain("Suspended");
  });
});

describe("frameIsForView", () => {
  test("frames from services before tabs are always shown", () => {
    expect(frameIsForView(undefined, 2)).toBe(true);
    expect(frameIsForView(undefined, "pending")).toBe(true);
  });

  test("only the shown tab's frames are drawn", () => {
    expect(frameIsForView(2, 2)).toBe(true);
    expect(frameIsForView(1, 2)).toBe(false);
  });

  test("before the service names a tab, any tab's frame is shown", () => {
    expect(frameIsForView(3, undefined)).toBe(true);
  });

  test("while a new tab is pending, every tabbed frame is dropped", () => {
    expect(frameIsForView(1, "pending")).toBe(false);
  });
});

describe("confirming a tab request", () => {
  test("a switch waits for the target tab, ignoring the old tab's late state", () => {
    const ok = confirmsSwitch(2);
    expect(ok(st(1, [1, 2]))).toBe(false);
    expect(ok(st(2, [1, 2]))).toBe(true);
  });

  test("a switch to a tab that closed meanwhile takes wherever the service moved the socket", () => {
    expect(confirmsSwitch(2)(st(1, [1]))).toBe(true);
  });

  test("a new tab is confirmed only by an id above every tab open when it was asked for", () => {
    const ok = confirmsNewTab([tab(1), tab(3)]);
    expect(ok(st(3, [1, 3]))).toBe(false);
    expect(ok(st(1, [1, 3]))).toBe(false);
    expect(ok(st(4, [1, 3, 4]))).toBe(true);
  });

  test("closing the shown tab is confirmed by any other tab, including the blank one that replaces the last", () => {
    const ok = confirmsClose(1);
    expect(ok(st(1, [1, 2]))).toBe(false);
    expect(ok(st(2, [2]))).toBe(true);
  });
});
