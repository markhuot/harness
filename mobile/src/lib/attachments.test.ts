import { describe, expect, test } from "bun:test";
import { clampPage, dismissOnRelease, fitSize, formatSize, pageAt, pullOf, shouldDismiss, thumbSize, THUMB } from "./attachments";

const img = (width?: number, height?: number) => ({ kind: "image" as const, width, height });

describe("thumbSize", () => {
  test("follows the aspect ratio at the row height", () => {
    expect(thumbSize(img(1600, 1200))).toEqual({ width: 160, height: THUMB.height });
    expect(thumbSize(img(1000, 1000))).toEqual({ width: 120, height: THUMB.height });
  });

  test("clamps panoramas and tall phone screenshots", () => {
    expect(thumbSize(img(4000, 500)).width).toBe(THUMB.maxWidth);
    expect(thumbSize(img(1179, 2556)).width).toBe(THUMB.minWidth);
  });

  test("unknown, zero or partial sizes fall back to the kind's default instead of NaN", () => {
    expect(thumbSize(img()).width).toBe(160); // 4:3
    expect(thumbSize(img(0, 0)).width).toBe(160);
    expect(thumbSize(img(800, undefined)).width).toBe(160);
    expect(thumbSize({ kind: "video" }).width).toBe(213); // 16:9
  });
});

describe("fitSize", () => {
  const screen = { width: 390, height: 700 };

  test("a wide image fits the width, a tall one the height", () => {
    expect(fitSize(img(2000, 1000), screen)).toEqual({ width: 390, height: 195 });
    expect(fitSize(img(1000, 4000), screen)).toEqual({ width: 175, height: 700 });
  });

  test("never upscales past the image's own pixels", () => {
    expect(fitSize(img(200, 100), screen)).toEqual({ width: 200, height: 100 });
  });

  test("unknown sizes fill the box at the default ratio; an empty box gives zero", () => {
    expect(fitSize(img(), screen)).toEqual({ width: 390, height: 293 });
    expect(fitSize(img(200, 100), { width: 0, height: 700 })).toEqual({ width: 0, height: 0 });
  });
});

describe("paging", () => {
  test("clampPage keeps the index in range and handles an empty list", () => {
    expect(clampPage(-1, 3)).toBe(0);
    expect(clampPage(5, 3)).toBe(2);
    expect(clampPage(1, 3)).toBe(1);
    expect(clampPage(2, 0)).toBe(0);
    expect(clampPage(Number.NaN, 3)).toBe(0);
  });

  test("pageAt rounds to the nearest page and clamps overscroll", () => {
    expect(pageAt(0, 390, 3)).toBe(0);
    expect(pageAt(390 * 1.49, 390, 3)).toBe(1);
    expect(pageAt(390 * 1.51, 390, 3)).toBe(2);
    expect(pageAt(390 * 2 + 80, 390, 3)).toBe(2); // bounce past the last page
    expect(pageAt(-60, 390, 3)).toBe(0);
    expect(pageAt(500, 0, 3)).toBe(0); // before layout
  });
});

describe("swipe down to close", () => {
  test("a long drag closes, a short slow one springs back, a short flick closes", () => {
    expect(shouldDismiss(130, 0)).toBe(true);
    expect(shouldDismiss(60, 0.2)).toBe(false);
    expect(shouldDismiss(60, 1.2)).toBe(true);
    expect(shouldDismiss(20, 3)).toBe(false); // a tap-ish jitter, however fast
    expect(shouldDismiss(-200, -3)).toBe(false); // upward
  });

  test("the pull comes from the page's negative bounce offset, and not while zoomed", () => {
    expect(pullOf(-80)).toBe(80);
    expect(pullOf(40)).toBe(0); // scrolled up past the top: no pull
    expect(pullOf(-80, 2)).toBe(0);
  });

  test("releasing a page: iOS's downward velocity is negative; a zoomed page never closes", () => {
    expect(dismissOnRelease(-150, 0)).toBe(true);
    expect(dismissOnRelease(-60, -1.2)).toBe(true); // short flick down
    expect(dismissOnRelease(-60, 1.2)).toBe(false); // flicked back up before letting go
    expect(dismissOnRelease(-60, -0.2)).toBe(false);
    expect(dismissOnRelease(-300, -3, 2)).toBe(false);
  });
});

describe("formatSize", () => {
  test("picks a unit and rounds", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(25 * 1024 * 1024)).toBe("25 MB");
  });

  test("promotes when rounding reaches the next unit", () => {
    expect(formatSize(1024 * 1024 - 20)).toBe("1 MB");
  });
});
