import { describe, expect, test } from "bun:test";
import {
  annotationNotesLabel,
  annotationStyle,
  arrowGeometry,
  badgeCenter,
  draftMarksFrom,
  hitTestMarks,
  isAnnotationDrag,
  marksForMessage,
  moveMark,
  removeMark,
  sameAnnotation,
  setMarkElement,
  setMarkMessage,
  toSurface,
  toUnit,
  type DraftMark,
} from "../../../shared/src/state/annotations";

const mark = (over: Partial<DraftMark> = {}): DraftMark => ({ anchor: { x: 0.5, y: 0.5 }, tail: null, message: "", ...over });
const style = annotationStyle(900, 900); // k = 1: radius 13, head 16

describe("annotationStyle", () => {
  test("scales with the long side, either orientation", () => {
    expect(annotationStyle(1800, 100).badgeRadius).toBe(26);
    expect(annotationStyle(100, 1800).badgeRadius).toBe(26);
  });
  test("small surfaces keep a 0.75 minimum scale", () => {
    expect(annotationStyle(10, 10).badgeRadius).toBe(13 * 0.75);
    expect(annotationStyle(675, 1).fontSize).toBe(15 * 0.75);
  });
});

describe("toUnit / toSurface", () => {
  test("fractions of the surface, clamped into the image", () => {
    expect(toUnit({ x: 50, y: 25 }, 100, 100)).toEqual({ x: 0.5, y: 0.25 });
    expect(toUnit({ x: -5, y: 500 }, 100, 100)).toEqual({ x: 0, y: 1 });
  });
  test("a zero or negative surface gives 0, and non-finite points give 0", () => {
    expect(toUnit({ x: 5, y: 5 }, 0, -1)).toEqual({ x: 0, y: 0 });
    expect(toUnit({ x: NaN, y: Infinity }, 100, 100)).toEqual({ x: 0, y: 0 });
  });
  test("toSurface does not clamp", () => {
    expect(toSurface({ x: 0.5, y: 2 }, 100, 10)).toEqual({ x: 50, y: 20 });
  });
});

describe("isAnnotationDrag", () => {
  test("the threshold is inclusive and distance is euclidean", () => {
    expect(isAnnotationDrag({ x: 0, y: 0 }, { x: 5.9, y: 0 })).toBe(false);
    expect(isAnnotationDrag({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
    expect(isAnnotationDrag({ x: 0, y: 0 }, { x: 4, y: 4 })).toBe(false); // 5.66
    expect(isAnnotationDrag({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(true); // 7.07
    expect(isAnnotationDrag({ x: 0, y: 0 }, { x: 2, y: 0 }, 2)).toBe(true);
  });
});

test("badgeCenter is the tail, or the anchor for a click", () => {
  expect(badgeCenter(mark({ tail: { x: 0.1, y: 0.2 } }))).toEqual({ x: 0.1, y: 0.2 });
  expect(badgeCenter(mark())).toEqual({ x: 0.5, y: 0.5 });
});

describe("arrowGeometry", () => {
  test("too short to show past the badge: null, and the cutoff is inclusive", () => {
    // radius 13 + head*0.5 = 21
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 21, y: 0 }, style)).toBeNull();
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 21.5, y: 0 }, style)).not.toBeNull();
    expect(arrowGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, style)).toBeNull();
  });
  test("a rightward arrow: the line leaves the badge edge, the head's tip is on the anchor", () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, style)!;
    expect(g.line[0]).toEqual({ x: 13, y: 0 });
    expect(g.line[1].x).toBeCloseTo(100 - 16 + 16 * 0.3);
    expect(g.head[0]).toEqual({ x: 100, y: 0 });
    // the base is 16 back from the tip, and the two wings sit 9 either side of the axis
    expect(g.head[1].x).toBeCloseTo(84);
    expect(g.head[2].x).toBeCloseTo(84);
    expect(Math.abs(g.head[1].y)).toBeCloseTo(9);
    expect(g.head[1].y).toBeCloseTo(-g.head[2].y);
  });
  test("the same geometry holds pointing left (direction normalised, not assumed)", () => {
    const g = arrowGeometry({ x: 100, y: 0 }, { x: 0, y: 0 }, style)!;
    expect(g.line[0].x).toBeCloseTo(87);
    expect(g.head[1].x).toBeCloseTo(16);
  });
});

describe("hitTestMarks", () => {
  const W = 100;
  const H = 100;
  const s = { ...style, badgeRadius: 10, headLength: 5 }; // anchor radius = max(5, 10) = 10; badge hit radius 14
  test("a badge is hit within radius + 4, not beyond", () => {
    const marks = [mark({ anchor: { x: 0.5, y: 0.5 } })];
    expect(hitTestMarks(marks, { x: 64, y: 50 }, W, H, s)).toEqual({ index: 0, part: "badge" });
    expect(hitTestMarks(marks, { x: 64.5, y: 50 }, W, H, s)).toBeNull();
  });
  test("an arrow's anchor is hit only for marks with a tail", () => {
    const withTail = [mark({ anchor: { x: 0.8, y: 0.8 }, tail: { x: 0.1, y: 0.1 } })];
    expect(hitTestMarks(withTail, { x: 80, y: 90 }, W, H, s)).toEqual({ index: 0, part: "anchor" });
    const click = [mark({ anchor: { x: 0.8, y: 0.8 } })];
    // a click's anchor is its badge: within 14 it is a badge hit, at 12 beyond that none of the anchor logic applies
    expect(hitTestMarks(click, { x: 80, y: 95 }, W, H, s)).toBeNull();
  });
  test("the anchor radius floors at 10 when the head is short, and grows with a long head", () => {
    const m = [mark({ anchor: { x: 0.8, y: 0.8 }, tail: { x: 0.1, y: 0.1 } })];
    expect(hitTestMarks(m, { x: 80, y: 92 }, W, H, { ...s, headLength: 3 })).toBeNull();
    expect(hitTestMarks(m, { x: 80, y: 92 }, W, H, { ...s, headLength: 12 })).toEqual({ index: 0, part: "anchor" });
  });
  test("badges beat anchors, and the later mark wins an overlap", () => {
    const marks = [mark({ anchor: { x: 0.5, y: 0.5 } }), mark({ anchor: { x: 0.5, y: 0.5 } })];
    expect(hitTestMarks(marks, { x: 50, y: 50 }, W, H, s)).toEqual({ index: 1, part: "badge" });
    const arrow = mark({ anchor: { x: 0.5, y: 0.5 }, tail: { x: 0.1, y: 0.1 } });
    const other = mark({ anchor: { x: 0.9, y: 0.9 }, tail: { x: 0.5, y: 0.5 } });
    expect(hitTestMarks([arrow, other], { x: 50, y: 50 }, W, H, s)).toEqual({ index: 1, part: "badge" });
  });
  test("no marks, no hit", () => {
    expect(hitTestMarks([], { x: 1, y: 1 }, W, H, s)).toBeNull();
  });
});

describe("moveMark", () => {
  const marks = [mark({ message: "a", element: { path: "p", text: "t" } }), mark({ anchor: { x: 0.2, y: 0.2 }, tail: { x: 0.9, y: 0.9 }, element: { path: "q", text: "u" } })];
  test("an arrow's badge moves the tail only, leaving the anchor and its element", () => {
    const out = moveMark(marks, { index: 1, part: "badge" }, { x: 0.3, y: 0.4 });
    expect(out[1]).toMatchObject({ tail: { x: 0.3, y: 0.4 }, anchor: { x: 0.2, y: 0.2 }, element: { path: "q", text: "u" } });
  });
  test("a click's badge moves the anchor and forgets the element", () => {
    const out = moveMark(marks, { index: 0, part: "badge" }, { x: 0.7, y: 0.1 });
    expect(out[0]!.anchor).toEqual({ x: 0.7, y: 0.1 });
    expect("element" in out[0]!).toBe(false);
    expect(out[0]!.message).toBe("a");
  });
  test("an arrow's anchor moves the anchor, forgets the element, keeps the tail", () => {
    const out = moveMark(marks, { index: 1, part: "anchor" }, { x: 0.6, y: 0.6 });
    expect(out[1]).toMatchObject({ anchor: { x: 0.6, y: 0.6 }, tail: { x: 0.9, y: 0.9 } });
    expect("element" in out[1]!).toBe(false);
  });
  test("the destination is clamped, other marks are untouched, and the input is not mutated", () => {
    const out = moveMark(marks, { index: 0, part: "badge" }, { x: -3, y: 9 });
    expect(out[0]!.anchor).toEqual({ x: 0, y: 1 });
    expect(out[1]).toBe(marks[1]!);
    expect(marks[0]!.anchor).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("mark list edits", () => {
  const marks = [mark({ message: "a" }), mark({ message: "b" }), mark({ message: "c" })];
  test("removeMark drops one by index, renumbering implicitly", () => {
    expect(removeMark(marks, 1).map((m) => m.message)).toEqual(["a", "c"]);
    expect(removeMark(marks, 9)).toHaveLength(3);
  });
  test("setMarkMessage and setMarkElement touch only the indexed mark", () => {
    expect(setMarkMessage(marks, 2, "z").map((m) => m.message)).toEqual(["a", "b", "z"]);
    const withEl = setMarkElement(marks, 0, { path: "p", text: "t" });
    expect(withEl[0]!.element).toEqual({ path: "p", text: "t" });
    expect(withEl[1]).toBe(marks[1]!);
    expect(setMarkElement(withEl, 0, null)[0]!.element).toBeNull();
  });
});

describe("marksForMessage / draftMarksFrom", () => {
  test("numbers from 1, rounds to pixels, trims messages, and adds tail and element only when present", () => {
    const out = marksForMessage(
      [mark({ anchor: { x: 0.123, y: 0.456 }, message: "  hi  " }), mark({ anchor: { x: 0.5, y: 0.5 }, tail: { x: 0.25, y: 0.75 }, element: { path: "div>a", text: "Go" } })],
      200,
      100,
    );
    expect(out[0]).toEqual({ n: 1, x: 25, y: 46, message: "hi" });
    expect("tailX" in out[0]!).toBe(false);
    expect("path" in out[0]!).toBe(false);
    expect(out[1]).toEqual({ n: 2, x: 100, y: 50, message: "", tailX: 50, tailY: 75, path: "div>a", text: "Go" });
  });
  test("a null element adds no path", () => {
    expect("path" in marksForMessage([mark({ element: null })], 10, 10)[0]!).toBe(false);
  });
  test("drafts come back as fractions: a tail needs both coordinates, an element's text defaults to empty", () => {
    const back = draftMarksFrom({
      width: 200,
      height: 100,
      marks: [
        { n: 1, x: 100, y: 50, message: "m" },
        { n: 2, x: 20, y: 10, message: "", tailX: 40, tailY: 20, path: "p" },
        { n: 3, x: 0, y: 0, message: "", tailX: 40 },
      ],
    } as never);
    expect(back[0]).toEqual({ anchor: { x: 0.5, y: 0.5 }, tail: null, message: "m" });
    expect(back[1]).toEqual({ anchor: { x: 0.1, y: 0.1 }, tail: { x: 0.2, y: 0.2 }, message: "", element: { path: "p", text: "" } });
    expect(back[2]!.tail).toBeNull();
  });
  test("a message round trip keeps the pixels (to rounding)", () => {
    const drafts = [mark({ anchor: { x: 0.25, y: 0.5 }, tail: { x: 0.75, y: 0.125 }, message: "x" })];
    const marks = marksForMessage(drafts, 400, 400);
    expect(draftMarksFrom({ width: 400, height: 400, marks })).toEqual(drafts);
  });
});

test("annotationNotesLabel pluralises", () => {
  expect([annotationNotesLabel(0), annotationNotesLabel(1), annotationNotesLabel(3)]).toEqual(["0 notes", "1 note", "3 notes"]);
});

describe("sameAnnotation", () => {
  const a = { width: 1, height: 1, marks: [] } as never;
  test("both absent are the same; one absent is not", () => {
    expect(sameAnnotation(undefined, undefined)).toBe(true);
    expect(sameAnnotation(a, undefined)).toBe(false);
    expect(sameAnnotation(undefined, a)).toBe(false);
  });
  test("compares by content", () => {
    expect(sameAnnotation(a, { width: 1, height: 1, marks: [] } as never)).toBe(true);
    expect(sameAnnotation(a, { width: 2, height: 1, marks: [] } as never)).toBe(false);
  });
});
