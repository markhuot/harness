// Browser tab touch/keyboard/resize input (mobile/src/lib/browserInput.ts) for HarnessKit's
// BrowserInput.swift. TouchGesture takes explicit timestamps (no timers), so a gesture sequence is
// just a list of events; each case replays it through the real TS class and records what every
// event returned and the state after it.
import { keyPress, ResizeGate, textChangeInputs, textDelta, TouchGesture, type GestureOptions, type Point } from "../../../mobile/src/lib/browserInput";
import { fitRect, toPagePoint } from "../../src/state";
import { cases } from "../case";

type GestureEvent = { t: "begin" | "move" | "end"; x: number; y: number; at: number } | { t: "cancel" };

interface GestureInput {
  /** Stage (box the frame is letterboxed into) */
  stage: { w: number; h: number };
  /** Screencast frame size in page CSS pixels; null = no frame yet (toPage → null, scale 1, as the RN screen does) */
  page: { width: number; height: number } | null;
  options?: Omit<GestureOptions, "toPage" | "scale">;
  events: GestureEvent[];
}

function runGesture({ stage, page, options, events }: GestureInput) {
  const drawn = page ? fitRect(stage.w, stage.h, page.width, page.height) : { x: 0, y: 0, w: 0, h: 0 };
  const g = new TouchGesture({
    toPage: (p: Point) => (page ? toPagePoint(p, drawn, page) : null),
    scale: () => (page && drawn.w ? page.width / drawn.w : 1),
    ...options,
  });
  const outputs: unknown[] = [];
  const states: string[] = [];
  for (const e of events) {
    outputs.push(e.t === "cancel" ? g.cancel() : g[e.t]({ x: e.x, y: e.y }, e.at));
    states.push(g.state);
  }
  return { outputs, states };
}

// 1280×800 into 400×400: drawn at y 75…325, 3.2 page px per stage pt (the TS test's stage).
const wide = { stage: { w: 400, h: 400 }, page: { width: 1280, height: 800 } };
// 800×800 into 400×400: exactly 2 page px per stage pt, for pinning Math.round halves.
const square = { stage: { w: 400, h: 400 }, page: { width: 800, height: 800 } };
const b = (x: number, y: number, at: number): GestureEvent => ({ t: "begin", x, y, at });
const m = (x: number, y: number, at: number): GestureEvent => ({ t: "move", x, y, at });
const e = (x: number, y: number, at: number): GestureEvent => ({ t: "end", x, y, at });
const cancel: GestureEvent = { t: "cancel" };
const tap = (x: number, y: number, at: number) => [b(x, y, at), e(x, y, at + 50)];

export const gestureCases = cases(runGesture, {
  "tap within slop": { ...wide, events: [b(200, 200, 0), m(203, 201, 40), e(203, 201, 90)] },
  "movement just under slop is still a tap": { ...wide, events: [b(200, 200, 0), m(207.99, 200, 10), e(207.99, 200, 20)] },
  "movement exactly at slop pans": { ...wide, events: [b(200, 200, 0), m(208, 200, 10), e(208, 200, 20)] },
  "diagonal slop uses the hypotenuse": { ...wide, events: [b(200, 200, 0), m(205.6, 205.6, 10), e(205.6, 205.6, 20)] },
  "double tap at exactly the interval": { ...wide, events: [...tap(100, 100, 0), b(100, 100, 300), e(100, 100, 370)] },
  "second tap just past the interval is a new click": { ...wide, events: [...tap(100, 100, 0), b(100, 100, 300), e(100, 100, 371)] },
  "double tap at exactly the distance": { ...wide, events: [...tap(100, 100, 0), ...tap(124, 100, 100)] },
  "second tap just past the distance": { ...wide, events: [...tap(100, 100, 0), ...tap(124.01, 100, 100)] },
  "triple tap, and a fourth stays at 3": { ...wide, events: [...tap(100, 100, 0), ...tap(102, 100, 100), ...tap(104, 100, 200), ...tap(104, 100, 300)] },
  "a tap after a slow one restarts the count": { ...wide, events: [...tap(100, 100, 0), ...tap(100, 100, 100), ...tap(100, 100, 1000), ...tap(100, 100, 1100)] },
  "a letterbox tap does not reset the click count": { ...wide, events: [...tap(100, 100, 0), ...tap(100, 20, 60), ...tap(100, 100, 120)] },
  "a pan between taps keeps the earlier tap": { ...wide, events: [...tap(100, 100, 0), b(100, 200, 60), m(100, 150, 70), e(100, 150, 80), ...tap(100, 100, 150)] },
  "letterbox tap": { ...wide, events: [b(200, 20, 0), e(200, 20, 30)] },
  "tap that ends in the letterbox": { ...wide, events: [b(200, 80, 0), m(200, 74, 10), e(200, 74, 20)] },
  "pan up, right, then end": { ...wide, events: [b(200, 300, 0), m(200, 280, 30), m(210, 280, 60), e(210, 280, 90)] },
  "pan leaves the frame": { ...wide, events: [b(200, 100, 0), m(200, 90, 20), m(200, 40, 40), m(200, 30, 50), e(200, 30, 60)] },
  "pan starting in the letterbox only scrolls once inside": { ...wide, events: [b(200, 20, 0), m(200, 50, 10), m(200, 100, 20), m(200, 120, 30)] },
  "pan with no movement since the last point sends nothing": { ...wide, events: [b(200, 200, 0), m(200, 180, 10), m(200, 180, 20)] },
  "pan rounds halves toward +infinity": { ...square, events: [b(200, 200, 0), m(200, 190, 10), m(200, 190.25, 20), m(200, 189.75, 30), m(198.75, 189.75, 40), m(200, 191.25, 50)] },
  "sub-pixel pan still sends a zero wheel": { ...wide, events: [b(200, 200, 0), m(200, 190, 10), m(200, 190.1, 20)] },
  "hold just under long-press pans": { ...wide, events: [b(100, 200, 0), m(130, 200, 449), e(130, 200, 500)] },
  "hold exactly long-press drags": { ...wide, events: [b(100, 200, 0), m(130, 200, 450), m(150, 200, 500), e(150, 200, 600)] },
  "hold inside slop, then move: drag": { ...wide, events: [b(100, 200, 0), m(101, 200, 500), m(130, 200, 600), e(150, 200, 700)] },
  "drag outside the frame holds the last page point": { ...wide, events: [b(100, 200, 0), m(130, 200, 600), m(130, 20, 650), e(130, 10, 700)] },
  "long press starting in the letterbox pans instead": { ...wide, events: [b(100, 20, 0), m(100, 100, 600), m(100, 120, 650), e(100, 120, 700)] },
  "drag never fires a click afterwards": { ...wide, events: [b(100, 200, 0), m(130, 200, 600), e(130, 200, 700), ...tap(130, 200, 750)] },
  "cancel mid-drag releases": { ...wide, events: [b(100, 200, 0), m(130, 200, 600), cancel, m(1, 1, 700), e(1, 1, 710)] },
  "cancel mid-pan and while pending send nothing": { ...wide, events: [b(100, 200, 1000), m(100, 150, 1010), cancel, b(100, 200, 2000), cancel, e(100, 200, 2010)] },
  "cancel when idle": { ...wide, events: [cancel] },
  "move and end without begin": { ...wide, events: [m(100, 200, 0), e(100, 200, 10)] },
  "begin again without end restarts": { ...wide, events: [b(100, 200, 0), m(100, 150, 10), b(200, 200, 20), e(200, 200, 30)] },
  "no frame yet: nothing is sent": { stage: { w: 400, h: 400 }, page: null, events: [...tap(100, 100, 0), b(100, 200, 100), m(100, 150, 110), e(100, 150, 120), b(100, 200, 200), m(130, 200, 700), e(130, 200, 800)] },
  "custom options": {
    ...wide,
    options: { slop: 2, longPressMs: 100, doubleTapMs: 50, doubleTapSlop: 4 },
    events: [b(100, 200, 0), m(102, 200, 10), e(102, 200, 20), ...tap(100, 100, 100), ...tap(103, 100, 190), ...tap(103, 100, 300), b(100, 200, 400), m(110, 200, 500), e(110, 200, 510)],
  },
  "zero slop: any movement pans": { ...wide, options: { slop: 0 }, events: [b(200, 200, 0), m(200, 200, 10), e(200, 200, 20)] },
});

export const textDeltaCases = cases(({ prev, next }: { prev: string; next: string }) => textDelta(prev, next), {
  "first character": { prev: "", next: "a" },
  "append": { prev: "hel", next: "hello" },
  "delete": { prev: "hello", next: "hel" },
  "autocorrect replacement": { prev: "teh", next: "the" },
  "unchanged": { prev: "x", next: "x" },
  "clear": { prev: "abc", next: "" },
  "both empty": { prev: "", next: "" },
  "emoji appended": { prev: "hi", next: "hi😀" },
  "emoji deleted counts two code units": { prev: "hi😀", next: "hi" },
  "combining mark added": { prev: "e", next: "é" },
  "precomposed to decomposed": { prev: "é", next: "é" },
  "middle edit": { prev: "abcdef", next: "abXYef" },
});

/**
 * Two emoji that share a high surrogate: TS compares UTF-16 code units, so the prefix ends inside
 * the code point and `insert` starts with a lone low surrogate. JSON can't carry that as a
 * string the Swift side can decode, so the insert is written as its code units.
 */
export const textDeltaSplitSurrogateCases = cases(
  ({ prev, next }: { prev: string; next: string }) => {
    const { deletes, insert } = textDelta(prev, next);
    return { deletes, insertCodeUnits: [...Array(insert.length).keys()].map((i) => insert.charCodeAt(i)) };
  },
  {
    "emoji swapped for one with the same high surrogate": { prev: "a😀", next: "a😃" },
    "emoji swapped for one with another high surrogate": { prev: "a😀", next: "a🦊" },
  },
);

export const textChangeInputsCases = cases(({ prev, next }: { prev: string; next: string }) => textChangeInputs(prev, next), {
  "autocorrect plus space": { prev: "teh", next: "the " },
  "unchanged": { prev: "a", next: "a" },
  "typing": { prev: "", next: "hi" },
  "three deletes": { prev: "abc", next: "" },
  "newline is text, not Enter": { prev: "a", next: "a\n" },
  "emoji delete is two Backspaces": { prev: "😀", next: "" },
});

export const keyPressCases = cases(keyPress, {
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  "lower-case enter": "enter",
  printable: "a",
  space: " ",
  empty: "",
  "ArrowLeft is not named": "ArrowLeft",
});

type GateOp = { op: "take"; width: number; height: number } | { op: "confirm" } | { op: "reset" };

export const resizeGateCases = cases(
  (ops: GateOp[]) => {
    const g = new ResizeGate();
    return ops.map((o) => (o.op === "take" ? g.take(o.width, o.height) : o.op === "confirm" ? g.confirm() : (g.reset(), null)));
  },
  {
    "the TS test sequence": [
      { op: "take", width: 390, height: 600 },
      { op: "confirm" },
      { op: "confirm" },
      { op: "take", width: 390.4, height: 600.2 },
      { op: "take", width: 390, height: 600 },
      { op: "take", width: 0, height: 600 },
      { op: "take", width: 390, height: 520 },
      { op: "reset" },
      { op: "take", width: 390, height: 520 },
      { op: "confirm" },
      { op: "take", width: 390, height: 520 },
    ],
    "rounding halves and sub-half sizes": [
      { op: "confirm" },
      { op: "take", width: 0.4, height: 600 },
      { op: "take", width: 0.5, height: 600 },
      { op: "take", width: 389.5, height: 599.49 },
      { op: "take", width: 390.49, height: 599.4 },
      { op: "take", width: 390, height: -1 },
      { op: "take", width: 600, height: 390 },
    ],
    "a size rejected as empty does not clear the last one sent": [
      { op: "confirm" },
      { op: "take", width: 300, height: 300 },
      { op: "take", width: 0, height: 0 },
      { op: "take", width: 300, height: 300 },
    ],
  },
);
