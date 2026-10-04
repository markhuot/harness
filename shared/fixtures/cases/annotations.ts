// Annotation geometry (shared/src/state/annotations.ts) for HarnessKit's Logic/Annotations.swift.
import type { AnnotationMark, MessageAnnotation } from "../../src/protocol";
import {
  annotationFor,
  annotationsWithin,
  annotationsWithout,
  draftMarksFrom,
  sameAnnotations,
  withAnnotation,
  annotationNotesLabel,
  annotationStyle,
  arrowGeometry,
  hitTestMarks,
  isAnnotationDrag,
  marksForMessage,
  moveMark,
  removeMark,
  setMarkMessage,
  toUnit,
  type DraftMark,
  type MarkHit,
  type Point,
} from "../../src/state/annotations";
import { cases } from "../case";

type Size = { width: number; height: number };

const tap = (x: number, y: number, message = ""): DraftMark => ({ anchor: { x, y }, tail: null, message });
const arrow = (x: number, y: number, tx: number, ty: number, message = ""): DraftMark => ({ anchor: { x, y }, tail: { x: tx, y: ty }, message });

export const annotationStyleCases = cases(({ width, height }: Size) => annotationStyle(width, height), {
  "the reference size": { width: 900, height: 600 },
  "a tall image uses its height": { width: 600, height: 1800 },
  "a retina screenshot": { width: 2560, height: 1600 },
  "a small image keeps the floor": { width: 320, height: 240 },
  "just above the floor": { width: 700, height: 100 },
  "exactly at the floor": { width: 675, height: 675 },
  "an empty surface": { width: 0, height: 0 },
});

type DragInput = { start: Point; end: Point; threshold?: number };
export const isAnnotationDragCases = cases(({ start, end, threshold }: DragInput) => isAnnotationDrag(start, end, threshold), {
  "no movement": { start: { x: 10, y: 10 }, end: { x: 10, y: 10 } },
  "just under the threshold": { start: { x: 10, y: 10 }, end: { x: 15.9, y: 10 } },
  "exactly the threshold": { start: { x: 10, y: 10 }, end: { x: 16, y: 10 } },
  "a diagonal 3-4-5 under it": { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } },
  "a diagonal past it": { start: { x: 0, y: 0 }, end: { x: -6, y: -8 } },
  "a custom threshold": { start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, threshold: 5 },
  "under a custom threshold": { start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, threshold: 5.01 },
});

type UnitInput = { p: Point; width: number; height: number };
export const toUnitCases = cases(({ p, width, height }: UnitInput) => toUnit(p, width, height), {
  "inside": { p: { x: 320, y: 120 }, width: 640, height: 480 },
  "the far corner": { p: { x: 640, y: 480 }, width: 640, height: 480 },
  "left of and above the image": { p: { x: -20, y: -1 }, width: 640, height: 480 },
  "past the right and bottom": { p: { x: 900, y: 481 }, width: 640, height: 480 },
  "a zero-size surface": { p: { x: 10, y: 10 }, width: 0, height: 0 },
  "a zero width only": { p: { x: 10, y: 240 }, width: 0, height: 480 },
});

type ArrowInput = { tail: Point; anchor: Point } & Size;
export const arrowGeometryCases = cases(({ tail, anchor, width, height }: ArrowInput) => arrowGeometry(tail, anchor, annotationStyle(width, height)), {
  "a horizontal arrow": { tail: { x: 100, y: 100 }, anchor: { x: 300, y: 100 }, width: 900, height: 600 },
  "pointing up and left": { tail: { x: 400, y: 300 }, anchor: { x: 100, y: 0 }, width: 900, height: 600 },
  "a diagonal on a retina image": { tail: { x: 1000, y: 200 }, anchor: { x: 1600, y: 1000 }, width: 2560, height: 1600 },
  "too short for an arrow": { tail: { x: 100, y: 100 }, anchor: { x: 110, y: 110 }, width: 900, height: 600 },
  "exactly the cutoff is too short": { tail: { x: 0, y: 0 }, anchor: { x: 21, y: 0 }, width: 900, height: 600 },
  "just past the cutoff": { tail: { x: 0, y: 0 }, anchor: { x: 21.01, y: 0 }, width: 900, height: 600 },
  "the same point": { tail: { x: 50, y: 50 }, anchor: { x: 50, y: 50 }, width: 900, height: 600 },
});

type HitInput = { marks: DraftMark[]; p: Point } & Size;
export const hitTestMarksCases = cases(({ marks, p, width, height }: HitInput) => hitTestMarks(marks, p, width, height, annotationStyle(width, height)), {
  "no marks": { marks: [], p: { x: 10, y: 10 }, width: 900, height: 600 },
  "a tap's badge": { marks: [tap(0.5, 0.5)], p: { x: 455, y: 300 }, width: 900, height: 600 },
  "just outside a badge": { marks: [tap(0.5, 0.5)], p: { x: 467.1, y: 300 }, width: 900, height: 600 },
  "the edge of a badge counts": { marks: [tap(0.5, 0.5)], p: { x: 467, y: 300 }, width: 900, height: 600 },
  "an arrow's tail is its badge": { marks: [arrow(0.2, 0.2, 0.6, 0.6)], p: { x: 540, y: 360 }, width: 900, height: 600 },
  "an arrow's anchor": { marks: [arrow(0.2, 0.2, 0.6, 0.6)], p: { x: 190, y: 125 }, width: 900, height: 600 },
  "a badge beats an anchor under it": { marks: [arrow(0.5, 0.5, 0.9, 0.9), tap(0.5, 0.5)], p: { x: 450, y: 300 }, width: 900, height: 600 },
  "a badge beats a later mark's anchor": { marks: [tap(0.5, 0.5), arrow(0.5, 0.5, 0.1, 0.1)], p: { x: 450, y: 300 }, width: 900, height: 600 },
  "a later badge beats an earlier one": { marks: [tap(0.5, 0.5), tap(0.51, 0.5)], p: { x: 452, y: 300 }, width: 900, height: 600 },
  "a later anchor beats an earlier one": { marks: [arrow(0.5, 0.5, 0.1, 0.1), arrow(0.5, 0.5, 0.9, 0.1)], p: { x: 452, y: 300 }, width: 900, height: 600 },
  "the anchor radius floor on a small image": { marks: [arrow(0.5, 0.5, 0.1, 0.1)], p: { x: 160 + 12, y: 120 }, width: 320, height: 240 },
  "a miss": { marks: [tap(0.1, 0.1), arrow(0.2, 0.2, 0.3, 0.3)], p: { x: 800, y: 500 }, width: 900, height: 600 },
});

type MoveInput = { marks: DraftMark[]; hit: MarkHit; to: Point };
const pair = [arrow(0.2, 0.2, 0.4, 0.4, "first"), tap(0.7, 0.7, "second")];
export const moveMarkCases = cases(({ marks, hit, to }: MoveInput) => moveMark(marks, hit, to), {
  "an arrow's badge moves its tail": { marks: pair, hit: { index: 0, part: "badge" }, to: { x: 0.5, y: 0.1 } },
  "an arrow's anchor moves its anchor": { marks: pair, hit: { index: 0, part: "anchor" }, to: { x: 0.25, y: 0.3 } },
  "a tap's badge moves its anchor": { marks: pair, hit: { index: 1, part: "badge" }, to: { x: 0.9, y: 0.05 } },
  "past the edges is clamped": { marks: pair, hit: { index: 0, part: "badge" }, to: { x: -0.4, y: 1.7 } },
  "an index out of range changes nothing": { marks: pair, hit: { index: 5, part: "badge" }, to: { x: 0.5, y: 0.5 } },
});

type MessageInput = { marks: DraftMark[] } & Size;
const three = [tap(0.1, 0.1, " one "), arrow(0.5, 0.5, 0.75, 0.25, "two"), tap(0.9, 0.9, "three\n")];
export const marksForMessageCases = cases(({ marks, width, height }: MessageInput): AnnotationMark[] => marksForMessage(marks, width, height), {
  "none": { marks: [], width: 640, height: 480 },
  "numbered in order, trimmed": { marks: three, width: 640, height: 480 },
  "rounded to whole pixels (half rounds up)": { marks: [arrow(0.00078125, 0.5, 0.3337, 0.6669, "round")], width: 640, height: 3 },
  "the far edge": { marks: [arrow(1, 1, 0, 0, "corner")], width: 1170, height: 2532 },
  "whitespace-only becomes empty": { marks: [tap(0.5, 0.5, " \t\n ")], width: 100, height: 100 },
});

type RemoveInput = { marks: DraftMark[]; index: number } & Size;
export const removeMarkCases = cases(({ marks, index, width, height }: RemoveInput) => marksForMessage(removeMark(marks, index), width, height), {
  "the first renumbers the rest": { marks: three, index: 0, width: 640, height: 480 },
  "the middle": { marks: three, index: 1, width: 640, height: 480 },
  "the last": { marks: three, index: 2, width: 640, height: 480 },
  "out of range": { marks: three, index: 3, width: 640, height: 480 },
  "negative": { marks: three, index: -1, width: 640, height: 480 },
});

type SetMessageInput = { marks: DraftMark[]; index: number; message: string };
export const setMarkMessageCases = cases(({ marks, index, message }: SetMessageInput) => setMarkMessage(marks, index, message), {
  "replaces one": { marks: three, index: 1, message: "Make this blue" },
  "out of range": { marks: three, index: 7, message: "nope" },
});

export const annotationNotesLabelCases = cases(annotationNotesLabel, {
  zero: 0,
  one: 1,
  two: 2,
  many: 50,
});

// Keeping annotations on their attachments as a message's or New session's list changes.
const note = (attachment: number, name: string): MessageAnnotation => ({
  attachment,
  source: { kind: "file", name },
  width: 640,
  height: 480,
  marks: [{ n: 1, x: 320, y: 240, tailX: 100, tailY: 80, message: name }],
});
const notes = [note(0, "first"), note(2, "third"), note(3, "fourth")];

export const annotationForCases = cases(({ list, index }: { list: MessageAnnotation[]; index: number }) => annotationFor(list, index) ?? null, {
  "an annotated attachment": { list: notes, index: 2 },
  "one without": { list: notes, index: 1 },
  "none at all": { list: [], index: 0 },
});

export const withAnnotationCases = cases(
  ({ list, index, a }: { list: MessageAnnotation[]; index: number; a: Omit<MessageAnnotation, "attachment"> | null }) => withAnnotation(list, index, a),
  {
    "added between, in attachment order": { list: notes, index: 1, a: note(9, "second") },
    "replaces the one on that attachment": { list: notes, index: 2, a: note(9, "third again") },
    "null removes it": { list: notes, index: 0, a: null },
    "into an empty list": { list: [], index: 4, a: note(0, "only") },
  },
);

export const annotationsWithoutCases = cases(({ list, index }: { list: MessageAnnotation[]; index: number }) => annotationsWithout(list, index), {
  "an annotated one: later ones move up": { list: notes, index: 2 },
  "one without notes: later ones still move up": { list: notes, index: 1 },
  "the last": { list: notes, index: 3 },
  "past the end changes nothing": { list: notes, index: 9 },
});

export const annotationsWithinCases = cases(({ list, count }: { list: MessageAnnotation[]; count: number }) => annotationsWithin(list, count), {
  "drops ones past the list": { list: notes, count: 3 },
  "an empty list keeps none": { list: notes, count: 0 },
  "all still there": { list: notes, count: 4 },
});

export const sameAnnotationsCases = cases(({ a, b }: { a: MessageAnnotation[]; b: MessageAnnotation[] }) => sameAnnotations(a, b), {
  "equal": { a: notes, b: notes.map((n) => ({ ...n })) },
  "a message changed": { a: notes, b: [notes[0]!, { ...notes[1]!, marks: [{ ...notes[1]!.marks[0]!, message: "edited" }] }, notes[2]!] },
  "one fewer": { a: notes, b: notes.slice(1) },
});

export const draftMarksFromCases = cases(draftMarksFrom, {
  "an arrow and a click": { width: 200, height: 100, marks: [{ n: 1, x: 50, y: 25, tailX: 100, tailY: 100, message: "a" }, { n: 2, x: 200, y: 0, message: "" }] },
  "none": { width: 10, height: 10, marks: [] },
});
