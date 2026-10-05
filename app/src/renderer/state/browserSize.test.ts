import { describe, expect, test } from "bun:test";
import type { BrowserSize, BrowserState } from "@harness/shared";
import { drivesSize, keepOwner, responsiveInput, responsiveLook, sideInput, takesOverSize, wheelAction } from "./browserSize";

const size = (responsive: boolean): BrowserSize => ({ device: "desktop", width: 1280, height: 800, responsive });

describe("drivesSize", () => {
  test("only the owner of a responsive tab sends its stage size", () => {
    expect(drivesSize({ size: size(true), sizeOwner: true })).toBe(true);
    expect(drivesSize({ size: size(true), sizeOwner: false })).toBe(false);
    expect(drivesSize({ size: size(true) })).toBe(false);
  });

  test("a fixed-size tab is never resized by a pane, even one flagged owner", () => {
    expect(drivesSize({ size: size(false), sizeOwner: true })).toBe(false);
  });

  test("an older service (no size) is driven by every pane; no state yet drives nothing", () => {
    expect(drivesSize({})).toBe(true);
    expect(drivesSize(null)).toBe(false);
  });
});

describe("takesOverSize", () => {
  const owned = (tabId: number) => ({ tabId, size: size(true), sizeOwner: true });
  const following = (tabId: number) => ({ tabId, size: size(true), sizeOwner: false });

  test("a pane handed the tab later (the owner left) sends its size", () => {
    expect(takesOverSize(following(1), owned(1))).toBe(true);
  });

  test("the first state already owned (a new tab follows its viewer) counts", () => {
    expect(takesOverSize(null, owned(1))).toBe(true);
  });

  test("switching Responsive on here counts", () => {
    expect(takesOverSize({ tabId: 1, size: size(false), sizeOwner: true }, owned(1))).toBe(true);
  });

  test("owning another tab after moving to it counts, though both states say owner", () => {
    expect(takesOverSize(owned(1), owned(2))).toBe(true);
  });

  test("a later state of a tab it already drives doesn't resend", () => {
    expect(takesOverSize(owned(1), owned(1))).toBe(false);
  });

  test("following, fixed-size or an older service's tab is never taken over", () => {
    expect(takesOverSize(null, following(1))).toBe(false);
    expect(takesOverSize(following(1), { tabId: 1, size: size(false), sizeOwner: true })).toBe(false);
    expect(takesOverSize(null, { tabId: 1 })).toBe(false);
  });
});

describe("keepOwner", () => {
  const reply = (tabId: number): BrowserState => ({ sessionId: "s", tabId, url: "https://a.test/", title: "", loading: false, size: size(true) });

  test("an HTTP reply for the tab this pane owns keeps the ownership", () => {
    expect(keepOwner(reply(1), { tabId: 1, sizeOwner: true }).sizeOwner).toBe(true);
  });

  test("a reply for another tab doesn't inherit it", () => {
    expect(keepOwner(reply(2), { tabId: 1, sizeOwner: true }).sizeOwner).toBeUndefined();
  });

  test("with no socket state yet the reply stands as it is", () => {
    const r = reply(1);
    expect(keepOwner(r, null)).toBe(r);
    expect(keepOwner(r, { tabId: 1 })).toBe(r);
  });
});

describe("responsive switch", () => {
  test("looks off, lit for the owner, dimmed-lit for everyone else", () => {
    expect(responsiveLook(null)).toBe("off");
    expect(responsiveLook({})).toBe("off");
    expect(responsiveLook({ size: size(false), sizeOwner: true })).toBe("off");
    expect(responsiveLook({ size: size(true), sizeOwner: true })).toBe("owned");
    expect(responsiveLook({ size: size(true), sizeOwner: false })).toBe("following");
  });

  test("the owner switches it off; anyone else switches it on at their stage size (whole pixels)", () => {
    expect(responsiveInput("owned", { width: 900, height: 600 })).toEqual({ type: "responsive", on: false });
    expect(responsiveInput("off", { width: 900.4, height: 599.6 })).toEqual({ type: "responsive", on: true, width: 900, height: 600 });
    expect(responsiveInput("following", { width: 640, height: 480 })).toEqual({ type: "responsive", on: true, width: 640, height: 480 });
  });
});

describe("sideInput", () => {
  test("rounds and clamps to 100–4096", () => {
    expect(sideInput(" 1024 ", 1)).toBe(1024);
    expect(sideInput("393.6", 1)).toBe(394);
    expect(sideInput("12", 1)).toBe(100);
    expect(sideInput("99999", 1)).toBe(4096);
    expect(sideInput("-5", 1)).toBe(100);
  });

  test("text that isn't a number keeps the current side", () => {
    expect(sideInput("", 800)).toBe(800);
    expect(sideInput("wide", 800)).toBe(800);
  });
});

describe("wheelAction", () => {
  test("a pinch (ctrl wheel) zooms, in when spreading, out when pinching, zoomed or not", () => {
    const spread = wheelAction({ ctrlKey: true, deltaX: 0, deltaY: -10 }, false);
    const pinch = wheelAction({ ctrlKey: true, deltaX: 0, deltaY: 10 }, true);
    expect(spread.kind).toBe("zoom");
    expect(pinch.kind).toBe("zoom");
    expect(spread.kind === "zoom" && spread.factor).toBeGreaterThan(1);
    expect(pinch.kind === "zoom" && pinch.factor).toBeLessThan(1);
  });

  test("a plain scroll pans the frame against the delta while zoomed, and goes to the page at 1×", () => {
    expect(wheelAction({ ctrlKey: false, deltaX: 4, deltaY: 20 }, true)).toEqual({ kind: "pan", dx: -4, dy: -20 });
    expect(wheelAction({ ctrlKey: false, deltaX: 4, deltaY: 20 }, false)).toEqual({ kind: "page" });
  });
});
