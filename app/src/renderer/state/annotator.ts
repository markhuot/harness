// The annotator's pure rules (components/Annotator.tsx, DESIGN.md "Annotations"): its undo history,
// the annotation Add to message hands on (metadata on the attachment; the image is never changed),
// and where the marks sit over a thumbnail or the lightbox. No React or DOM, so they're tested on
// their own.

import type { AnnotationPage, AttachmentAnnotation } from "@harness/shared";
import { marksForMessage, type AnnotationStyle, type DraftMark } from "@harness/shared/state";

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export interface AnnotatorSnapshot {
  marks: DraftMark[];
}

/**
 * ⌘Z's history: the states before each change, newest last. `key` coalesces a run of changes into
 * one step (the keystrokes of one message field while it keeps the focus), so ⌘Z undoes the typing
 * as a whole, then the move or the new mark before it.
 */
export interface AnnotatorHistory {
  past: AnnotatorSnapshot[];
  /** The key of the newest step, while a run of changes with that key goes on. */
  key: string | null;
}

export const HISTORY_LIMIT = 100;

export const emptyHistory = (): AnnotatorHistory => ({ past: [], key: null });

/** `h` with `before` (the state before a change) as its newest step; a change with the same `key` as the last one is part of that step. */
export function recordChange(h: AnnotatorHistory, before: AnnotatorSnapshot, key: string | null = null): AnnotatorHistory {
  if (key !== null && key === h.key) return h;
  const past = [...h.past, before];
  return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, key };
}

/** Ends the current run, so the next change with the same key is a step of its own (a field lost the focus). */
export function endRun(h: AnnotatorHistory): AnnotatorHistory {
  return h.key === null ? h : { ...h, key: null };
}

/** The state to go back to and the history without it, or null when there's nothing to undo. */
export function undo(h: AnnotatorHistory): { state: AnnotatorSnapshot; history: AnnotatorHistory } | null {
  const state = h.past[h.past.length - 1];
  if (!state) return null;
  return { state, history: { past: h.past.slice(0, -1), key: null } };
}

/**
 * Whether closing loses work, so Cancel and Esc ask first: the marks aren't the ones the annotator
 * opened with (reopening an annotated image and closing it untouched loses nothing; deleting its
 * marks would take its notes off, which is work too).
 */
export function hasAnnotatorWork(marks: readonly DraftMark[], initial: readonly DraftMark[] = []): boolean {
  return JSON.stringify(marks) !== JSON.stringify(initial);
}

// ---------------------------------------------------------------------------
// The annotation
// ---------------------------------------------------------------------------

/**
 * What Add to message keeps on the attachment: the marks in pixels of the `width`×`height` image,
 * and the browser page it shows (a new screenshot's, else the one it was annotated with before, so
 * editing the marks of a page keeps the page). No marks: null, which takes the notes off.
 */
export function annotationFromMarks(marks: readonly DraftMark[], width: number, height: number, page?: AnnotationPage | null): AttachmentAnnotation | null {
  if (!marks.length) return null;
  return { width, height, marks: marksForMessage(marks, width, height), ...(page ? { page } : {}) };
}

/** A browser page's name for its screenshot: the host, else the title, else "page". */
export function browserShotName(url: string, title: string): string {
  try {
    const host = new URL(url).hostname;
    if (host) return host;
  } catch {}
  return title.trim() || "page";
}

// ---------------------------------------------------------------------------
// Drawing over an image shown somewhere else
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a `iw`×`ih` image lands in a `bw`×`bh` box it covers (CSS object-fit: cover): scaled to fill
 * the box, centred, its overflow cut off. The marks are drawn over this rect, so they stay on the
 * spots they point at in a cropped thumbnail.
 */
export function coverRect(bw: number, bh: number, iw: number, ih: number): Rect {
  if (iw <= 0 || ih <= 0) return { x: 0, y: 0, w: bw, h: bh };
  const k = Math.max(bw / iw, bh / ih);
  const w = iw * k;
  const h = ih * k;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

/**
 * The marks' style in a thumbnail `side` points across: a fixed share of the box rather than of the
 * image, so a big screenshot's marks don't shrink to nothing and a small one's don't fill the box.
 */
export function thumbnailStyle(side: number): AnnotationStyle {
  return { badgeRadius: side * 0.17, fontSize: side * 0.22, lineWidth: side * 0.05, outline: side * 0.03, headLength: side * 0.16, headHalfWidth: side * 0.09 };
}
