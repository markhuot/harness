// Annotations (DESIGN.md "Annotations"): numbered notes a human draws on an image before sending
// it to the agent. Press to set an anchor, drag to pull out an arrow that points at it; the number
// sits where the arrow starts. These are the rules both apps draw and edit with (the iOS app
// mirrors them in HarnessKit's Annotations.swift, with the same tests). Platform-independent: no
// React, DOM or native APIs.

import type { AnnotationMark, MessageAnnotation } from "../protocol";

export interface Point {
  x: number;
  y: number;
}

/**
 * A note while it's being drawn. Points are fractions (0–1) of the image's width and height, so
 * they hold at any display size. `tail` is where the drag ended; null for a plain click, which puts
 * the number on the anchor itself.
 */
export interface DraftMark {
  anchor: Point;
  tail: Point | null;
  message: string;
}

/** How far (in display points) the pointer has to move between press and release to make an arrow rather than a click. */
export const ANNOTATION_DRAG_THRESHOLD = 6;

/** Sizes, in pixels of the surface being drawn on, of a mark's pieces. */
export interface AnnotationStyle {
  badgeRadius: number;
  fontSize: number;
  lineWidth: number;
  /** The white outline around the badge and the arrow, so they read on light and dark images. */
  outline: number;
  headLength: number;
  headHalfWidth: number;
}

/**
 * The style for a surface of `width`×`height` pixels. It grows with the image's long side, so the
 * picture sent to the agent looks like what was on screen at any resolution; very small surfaces
 * keep a readable minimum.
 */
export function annotationStyle(width: number, height: number): AnnotationStyle {
  const k = Math.max(Math.max(width, height) / 900, 0.75);
  return { badgeRadius: 13 * k, fontSize: 15 * k, lineWidth: 3.5 * k, outline: 2 * k, headLength: 16 * k, headHalfWidth: 9 * k };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** A surface pixel as a fraction of the surface, kept inside the image. */
export function toUnit(p: Point, width: number, height: number): Point {
  return { x: clamp01(width > 0 ? p.x / width : 0), y: clamp01(height > 0 ? p.y / height : 0) };
}

/** A fraction of the surface as a surface pixel. */
export function toSurface(p: Point, width: number, height: number): Point {
  return { x: p.x * width, y: p.y * height };
}

/** Did the pointer move far enough between press and release to make an arrow? (Display points.) */
export function isAnnotationDrag(start: Point, end: Point, threshold = ANNOTATION_DRAG_THRESHOLD): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= threshold;
}

/** Where a mark's number is drawn: the arrow's tail, or the anchor for a click. */
export function badgeCenter(m: DraftMark): Point {
  return m.tail ?? m.anchor;
}

/**
 * The arrow from `tail` to `anchor` (surface pixels): a line from the edge of the badge to the base
 * of the head, and the head's three points with its tip on the anchor. null when the two are too
 * close for an arrow to show past the badge; the badge alone marks the spot then.
 */
export function arrowGeometry(tail: Point, anchor: Point, style: AnnotationStyle): { line: [Point, Point]; head: [Point, Point, Point] } | null {
  const dx = anchor.x - tail.x;
  const dy = anchor.y - tail.y;
  const length = Math.hypot(dx, dy);
  if (length <= style.badgeRadius + style.headLength * 0.5) return null;
  const ux = dx / length;
  const uy = dy / length;
  const base = { x: anchor.x - ux * style.headLength, y: anchor.y - uy * style.headLength };
  const start = { x: tail.x + ux * style.badgeRadius, y: tail.y + uy * style.badgeRadius };
  // The line stops a little inside the head, so its round cap doesn't poke past the head's sides.
  const end = { x: base.x + ux * style.headLength * 0.3, y: base.y + uy * style.headLength * 0.3 };
  const px = -uy * style.headHalfWidth;
  const py = ux * style.headHalfWidth;
  return {
    line: [start, end],
    head: [{ x: anchor.x, y: anchor.y }, { x: base.x + px, y: base.y + py }, { x: base.x - px, y: base.y - py }],
  };
}

/** Which mark a press lands on: its badge, or (for an arrow) the anchor its head points at. */
export interface MarkHit {
  index: number;
  part: "badge" | "anchor";
}

/**
 * The mark under surface point `p`, so a press there moves it instead of starting a new one.
 * Badges win over anchors, and a later mark over an earlier one (it's drawn on top).
 */
export function hitTestMarks(marks: readonly DraftMark[], p: Point, width: number, height: number, style: AnnotationStyle): MarkHit | null {
  const near = (u: Point, r: number) => {
    const s = toSurface(u, width, height);
    return Math.hypot(s.x - p.x, s.y - p.y) <= r;
  };
  for (let i = marks.length - 1; i >= 0; i--) if (near(badgeCenter(marks[i]!), style.badgeRadius + 4)) return { index: i, part: "badge" };
  const anchorRadius = Math.max(style.headLength, 10);
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i]!.tail && near(marks[i]!.anchor, anchorRadius)) return { index: i, part: "anchor" };
  return null;
}

/** `marks` with the hit part moved to `to` (a fraction of the surface). A click's badge is its anchor, so it moves the anchor. */
export function moveMark(marks: readonly DraftMark[], hit: MarkHit, to: Point): DraftMark[] {
  const at = { x: clamp01(to.x), y: clamp01(to.y) };
  return marks.map((m, i) => {
    if (i !== hit.index) return m;
    if (hit.part === "badge" && m.tail) return { ...m, tail: at };
    return { ...m, anchor: at };
  });
}

/** `marks` without the one at `index`; the ones after it move up a number. */
export function removeMark(marks: readonly DraftMark[], index: number): DraftMark[] {
  return marks.filter((_, i) => i !== index);
}

/** `marks` with the message of the one at `index` replaced. */
export function setMarkMessage(marks: readonly DraftMark[], index: number, message: string): DraftMark[] {
  return marks.map((m, i) => (i === index ? { ...m, message } : m));
}

/**
 * The marks as a message sends them (MessageAnnotation.marks): numbered 1…n in order, in pixels of
 * the `width`×`height` image, with trimmed messages.
 */
export function marksForMessage(marks: readonly DraftMark[], width: number, height: number): AnnotationMark[] {
  return marks.map((m, i) => {
    const out: AnnotationMark = { n: i + 1, x: Math.round(m.anchor.x * width), y: Math.round(m.anchor.y * height), message: m.message.trim() };
    if (m.tail) {
      out.tailX = Math.round(m.tail.x * width);
      out.tailY = Math.round(m.tail.y * height);
    }
    return out;
  });
}

/** "1 note", "3 notes": the Transcript's line under an annotated image. */
export function annotationNotesLabel(count: number): string {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

/**
 * The marks of a sent or waiting annotation, back as fractions of its image, so the annotator can
 * reopen them to edit (over the original image, which has the same size as the annotated one).
 */
export function draftMarksFrom(a: Pick<MessageAnnotation, "width" | "height" | "marks">): DraftMark[] {
  const unit = (x: number, y: number) => toUnit({ x, y }, a.width, a.height);
  return a.marks.map((m) => ({
    anchor: unit(m.x, m.y),
    tail: m.tailX !== undefined && m.tailY !== undefined ? unit(m.tailX, m.tailY) : null,
    message: m.message,
  }));
}

// A message (or New session) keeps its annotations beside its attachments, each naming its
// attachment by index. These keep them pointed at the right file as the list changes.

/** The annotation on `attachments[index]`, if it has one. */
export function annotationFor(annotations: readonly MessageAnnotation[], index: number): MessageAnnotation | undefined {
  return annotations.find((a) => a.attachment === index);
}

/** `annotations` with the one on `attachments[index]` set to `a` (null removes it), in attachment order. */
export function withAnnotation(annotations: readonly MessageAnnotation[], index: number, a: Omit<MessageAnnotation, "attachment"> | null): MessageAnnotation[] {
  const rest = annotations.filter((x) => x.attachment !== index);
  return (a ? [...rest, { ...a, attachment: index }] : rest).sort((x, y) => x.attachment - y.attachment);
}

/** `annotations` once `attachments[index]` is removed: its own goes, and later ones move up an index. */
export function annotationsWithout(annotations: readonly MessageAnnotation[], index: number): MessageAnnotation[] {
  return annotations.filter((a) => a.attachment !== index).map((a) => (a.attachment > index ? { ...a, attachment: a.attachment - 1 } : a));
}

/** Only the annotations whose attachment is still in a list of `count` (what a send or save carries). */
export function annotationsWithin(annotations: readonly MessageAnnotation[], count: number): MessageAnnotation[] {
  return annotations.filter((a) => Number.isInteger(a.attachment) && a.attachment >= 0 && a.attachment < count);
}

/** Same annotations, same order, same contents. */
export function sameAnnotations(a: readonly MessageAnnotation[], b: readonly MessageAnnotation[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}
