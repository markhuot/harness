import { describe, expect, test } from "bun:test";
import { BROWSER_ZOOM_MAX, clampZoomRect, panRect, zoomRect, zoomScale } from "./browserZoom";
import { fitRect, toPagePoint } from "./format";

const box = { w: 390, h: 700 };
const fit = fitRect(box.w, box.h, 1280, 800);
const page = { width: 1280, height: 800 };

describe("zoomRect", () => {
  test("the page point under the pinch stays under it", () => {
    // 3.5× makes the frame taller than the box too, so neither axis is re-centered.
    const anchor = { x: 120, y: 330 };
    const before = toPagePoint(anchor, fit, page)!;
    const after = toPagePoint(anchor, zoomRect(box, fit, fit, 3.5, anchor), page)!;
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  });

  test("an axis still shorter than the box stays centered rather than following the pinch", () => {
    const r = zoomRect(box, fit, fit, 2, { x: 120, y: 300 });
    expect(r.y).toBe((box.h - r.h) / 2);
  });

  test("is held to 1–max", () => {
    expect(zoomScale(fit, zoomRect(box, fit, fit, 100, { x: 195, y: 350 }))).toBe(BROWSER_ZOOM_MAX);
    expect(zoomRect(box, fit, zoomRect(box, fit, fit, 3, { x: 10, y: 300 }), 0.01, { x: 10, y: 300 })).toEqual(fit);
  });

  test("zooming in at the left edge leaves no gap on the left", () => {
    const r = zoomRect(box, fit, fit, 2, { x: 0, y: 350 });
    expect(r.x).toBe(0);
    expect(r.w).toBe(fit.w * 2);
  });

  test("a bad factor changes nothing", () => {
    const twice = zoomRect(box, fit, fit, 2, { x: 195, y: 350 });
    expect(zoomRect(box, fit, twice, Number.NaN, { x: 1, y: 1 })).toEqual(twice);
    expect(zoomRect(box, fit, twice, -1, { x: 1, y: 1 })).toEqual(twice);
  });
});

describe("panRect", () => {
  const twice = zoomRect(box, fit, fit, 2, { x: 195, y: 350 });

  test("at 1× nothing moves", () => {
    expect(panRect(box, fit, fit, 40, 40)).toEqual(fit);
  });

  test("stops at the edges", () => {
    expect(panRect(box, fit, twice, 10_000, 0).x).toBe(0);
    expect(panRect(box, fit, twice, -10_000, 0).x).toBe(box.w - twice.w);
  });

  test("an axis still smaller than the box stays centered", () => {
    // 2× of a 243.75-tall frame is 487.5, shorter than the 700 box.
    expect(panRect(box, fit, twice, 0, 300).y).toBe((box.h - twice.h) / 2);
  });
});

test("clampZoomRect snaps anything under 1× back to the fit", () => {
  expect(clampZoomRect(box, fit, { x: 5, y: 5, w: fit.w * 1.005, h: fit.h * 1.005 })).toEqual(fit);
});
