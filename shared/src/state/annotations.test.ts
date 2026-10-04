import { describe, expect, test } from "bun:test";
import {
  draftMarksFrom,
  sameAnnotation,
  annotationNotesLabel,
  annotationStyle,
  arrowGeometry,
  hitTestMarks,
  isAnnotationDrag,
  marksForMessage,
  moveMark,
  removeMark,
  toUnit,
  type DraftMark,
} from "./annotations";

// The iOS app mirrors these rules (HarnessKit Annotations.swift); its tests use the same cases.

const W = 1000;
const H = 500;
const style = annotationStyle(W, H);
const click = (x: number, y: number, message = ""): DraftMark => ({ anchor: { x, y }, tail: null, message });
const arrow = (ax: number, ay: number, tx: number, ty: number, message = ""): DraftMark => ({ anchor: { x: ax, y: ay }, tail: { x: tx, y: ty }, message });

describe("annotations", () => {
  test("a press that moves less than the threshold is a click; at the threshold it's an arrow", () => {
    expect(isAnnotationDrag({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(false); // 5 points
    expect(isAnnotationDrag({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(true); // 6 points
  });

  test("points outside the image are kept on its edge", () => {
    expect(toUnit({ x: -20, y: 600 }, W, H)).toEqual({ x: 0, y: 1 });
    expect(toUnit({ x: 250, y: 125 }, W, H)).toEqual({ x: 0.25, y: 0.25 });
  });

  test("deleting a mark renumbers the ones after it", () => {
    const marks = [click(0.1, 0.1, "one"), click(0.2, 0.2, "two"), arrow(0.3, 0.3, 0.5, 0.5, "three")];
    expect(marksForMessage(removeMark(marks, 1), W, H)).toEqual([
      { n: 1, x: 100, y: 50, message: "one" },
      { n: 2, x: 300, y: 150, tailX: 500, tailY: 250, message: "three" },
    ]);
  });

  test("marks are sent in image pixels, rounded, with trimmed messages", () => {
    expect(marksForMessage([arrow(0.1234, 0.5, 0.0005, 0.9999, "  look here \n")], 2880, 1800)).toEqual([
      { n: 1, x: 355, y: 900, tailX: 1, tailY: 1800, message: "look here" },
    ]);
  });

  test("a badge wins over an anchor under the same point, and a later mark over an earlier one", () => {
    // Mark 1's arrow points at (500, 250); mark 2 is a click at the same spot.
    const marks = [arrow(0.5, 0.5, 0.2, 0.2), click(0.5, 0.5)];
    expect(hitTestMarks(marks, { x: 500, y: 250 }, W, H, style)).toEqual({ index: 1, part: "badge" });
    // Two badges overlapping: the later one is on top.
    expect(hitTestMarks([click(0.5, 0.5), click(0.505, 0.5)], { x: 503, y: 250 }, W, H, style)).toEqual({ index: 1, part: "badge" });
    // Only the arrow's anchor is there.
    expect(hitTestMarks([arrow(0.5, 0.5, 0.2, 0.2)], { x: 502, y: 251 }, W, H, style)).toEqual({ index: 0, part: "anchor" });
    expect(hitTestMarks([arrow(0.5, 0.5, 0.2, 0.2)], { x: 700, y: 400 }, W, H, style)).toBeNull();
  });

  test("moving a badge moves an arrow's tail, but a click's anchor; moves stay inside the image", () => {
    const marks = [arrow(0.5, 0.5, 0.2, 0.2), click(0.7, 0.7)];
    expect(moveMark(marks, { index: 0, part: "badge" }, { x: 0.1, y: 0.1 })[0]).toEqual(arrow(0.5, 0.5, 0.1, 0.1));
    expect(moveMark(marks, { index: 0, part: "anchor" }, { x: 0.6, y: 1.4 })[0]).toEqual(arrow(0.6, 1, 0.2, 0.2));
    expect(moveMark(marks, { index: 1, part: "badge" }, { x: 0.9, y: 0.9 })[1]).toEqual(click(0.9, 0.9));
  });

  test("the arrow's tip is on the anchor and its line starts at the badge's edge", () => {
    const g = arrowGeometry({ x: 100, y: 100 }, { x: 400, y: 100 }, style)!;
    expect(g.head[0]).toEqual({ x: 400, y: 100 });
    expect(g.line[0]).toEqual({ x: 100 + style.badgeRadius, y: 100 });
    expect(g.line[1].x).toBeLessThan(400);
    expect(g.head[1].x).toBeCloseTo(400 - style.headLength);
    expect(Math.abs(g.head[1].y - g.head[2].y)).toBeCloseTo(style.headHalfWidth * 2);
  });

  test("no arrow when the tail is too close to the anchor to show past the badge", () => {
    expect(arrowGeometry({ x: 100, y: 100 }, { x: 100 + style.badgeRadius, y: 100 }, style)).toBeNull();
  });

  test("the style grows with the image so the sent picture matches the screen, with a floor for small images", () => {
    expect(annotationStyle(2700, 1200).badgeRadius).toBeCloseTo(annotationStyle(900, 400).badgeRadius * 3);
    expect(annotationStyle(100, 100).badgeRadius).toBe(annotationStyle(300, 200).badgeRadius);
  });

  test("the Transcript's label counts notes", () => {
    expect(annotationNotesLabel(1)).toBe("1 note");
    expect(annotationNotesLabel(3)).toBe("3 notes");
  });

  test("annotations compare by size, page and marks", () => {
    const a = { width: 10, height: 10, marks: [{ n: 1, x: 1, y: 1, message: "a" }] };
    expect(sameAnnotation(a, { ...a, marks: [{ ...a.marks[0]! }] })).toBe(true);
    expect(sameAnnotation(a, { ...a, marks: [{ ...a.marks[0]!, message: "b" }] })).toBe(false);
    expect(sameAnnotation(a, undefined)).toBe(false);
    expect(sameAnnotation(undefined, undefined)).toBe(true);
  });

  test("marks reopen as fractions of the image, with and without arrows", () => {
    const a = { width: 200, height: 100, marks: [{ n: 1, x: 50, y: 25, tailX: 100, tailY: 100, message: "a" }, { n: 2, x: 200, y: 0, message: "" }] };
    expect(draftMarksFrom(a)).toEqual([arrow(0.25, 0.25, 0.5, 1, "a"), click(1, 0, "")]);
    expect(marksForMessage(draftMarksFrom(a), 200, 100)).toEqual(a.marks);
  });
});
