// Pinch-zoom of a browser frame for HarnessKit's BrowserZoom.swift (shared/src/state/browserZoom.ts).
import { BROWSER_ZOOM_MAX, clampZoomRect, panRect, zoomRect, zoomScale } from "../../src/state/browserZoom";
import { fitRect, toPagePoint, type Rect } from "../../src/state/format";
import { cases } from "../case";

export const constants = { BROWSER_ZOOM_MAX };

type Box = { w: number; h: number };
// A desktop page (1280×800) letterboxed onto a phone-sized stage (390×700): 390×243.75 at y 228.125.
const phone: Box = { w: 390, h: 700 };
const fit = fitRect(phone.w, phone.h, 1280, 800);
const twice = zoomRect(phone, fit, fit, 2, { x: 195, y: 350 });

export const zoomScaleCases = cases(({ fit, drawn }: { fit: Rect; drawn: Rect }) => zoomScale(fit, drawn), {
  "not zoomed": { fit, drawn: fit },
  "zoomed twice": { fit, drawn: twice },
  "nothing fitted": { fit: { x: 0, y: 0, w: 0, h: 0 }, drawn: fit },
});

export const zoomRectCases = cases(
  ({ box, fit, drawn, factor, anchor }: { box: Box; fit: Rect; drawn: Rect; factor: number; anchor: { x: number; y: number } }) =>
    zoomRect(box, fit, drawn, factor, anchor),
  {
    "zoom in around the centre": { box: phone, fit, drawn: fit, factor: 2, anchor: { x: 195, y: 350 } },
    "zoom in around the left edge keeps it pinned": { box: phone, fit, drawn: fit, factor: 2, anchor: { x: 0, y: 350 } },
    "zoom in near the top-right corner": { box: phone, fit, drawn: fit, factor: 3, anchor: { x: 380, y: 240 } },
    "held to the maximum": { box: phone, fit, drawn: fit, factor: 10, anchor: { x: 195, y: 350 } },
    "zooming out past 1 snaps to the fit": { box: phone, fit, drawn: twice, factor: 0.25, anchor: { x: 100, y: 300 } },
    "just over 1 snaps to the fit": { box: phone, fit, drawn: fit, factor: 1.005, anchor: { x: 195, y: 350 } },
    "zoom out from twice to 1.5": { box: phone, fit, drawn: twice, factor: 0.75, anchor: { x: 195, y: 350 } },
    "a zero factor changes nothing": { box: phone, fit, drawn: twice, factor: 0, anchor: { x: 195, y: 350 } },
    "a NaN factor changes nothing": { box: phone, fit, drawn: twice, factor: Number.NaN, anchor: { x: 195, y: 350 } },
    "nothing fitted": { box: phone, fit: { x: 0, y: 0, w: 0, h: 0 }, drawn: { x: 0, y: 0, w: 0, h: 0 }, factor: 2, anchor: { x: 1, y: 1 } },
    // A phone-sized page in a wide pane: zoomed in, it still fits the box's width at 2×, so it stays centered across.
    "narrow frame stays centered across": {
      box: { w: 1200, h: 800 },
      fit: fitRect(1200, 800, 393, 852),
      drawn: fitRect(1200, 800, 393, 852),
      factor: 2,
      anchor: { x: 700, y: 400 },
    },
  },
);

export const panRectCases = cases(
  ({ box, fit, drawn, dx, dy }: { box: Box; fit: Rect; drawn: Rect; dx: number; dy: number }) => panRect(box, fit, drawn, dx, dy),
  {
    "not zoomed: nothing moves": { box: phone, fit, drawn: fit, dx: 50, dy: 50 },
    "zoomed: pans within the edges": { box: phone, fit, drawn: twice, dx: 40, dy: 0 },
    "zoomed: held at the left edge": { box: phone, fit, drawn: twice, dx: 1000, dy: 0 },
    "zoomed: held at the right edge": { box: phone, fit, drawn: twice, dx: -1000, dy: 0 },
    "zoomed: still shorter than the box, so it stays centered down": { box: phone, fit, drawn: twice, dx: 0, dy: 200 },
  },
);

export const clampZoomRectCases = cases(({ box, fit, rect }: { box: Box; fit: Rect; rect: Rect }) => clampZoomRect(box, fit, rect), {
  "smaller than the fit snaps to it": { box: phone, fit, rect: { x: 10, y: 10, w: 100, h: 62.5 } },
  "a gap on the left closes": { box: phone, fit, rect: { x: 30, y: 0, w: 780, h: 487.5 } },
  "taller than the box keeps no gap at the bottom": { box: phone, fit, rect: { x: -1000, y: -2000, w: 1560, h: 975 } },
});

// A tap mapped through a zoomed, panned frame lands on the page pixel under it.
const panned = panRect(phone, fit, zoomRect(phone, fit, fit, 4, { x: 300, y: 300 }), -20, 0);
export const zoomedTapCases = cases(({ local, drawn }: { local: { x: number; y: number }; drawn: Rect }) => toPagePoint(local, drawn, { width: 1280, height: 800 }), {
  "centre at 2×": { local: { x: 195, y: 350 }, drawn: twice },
  "left edge at 2×": { local: { x: 0, y: 350 }, drawn: twice },
  "zoomed 4× and panned": { local: { x: 120, y: 330 }, drawn: panned },
});
