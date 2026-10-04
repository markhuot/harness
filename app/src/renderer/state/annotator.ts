// The annotator's pure rules (components/Annotator.tsx, DESIGN.md "Annotations"): its undo history,
// how the annotated picture is encoded so it can go to the agent inline, what the file is called,
// and which lightbox items offer Annotate. No React or DOM, so they're tested on their own.

import type { DraftMark } from "@harness/shared/state";

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export interface AnnotatorSnapshot {
  marks: DraftMark[];
  note: string;
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

/** Whether closing loses work, so Cancel and Esc ask first. */
export function hasAnnotatorWork(s: AnnotatorSnapshot): boolean {
  return s.marks.length > 0 || s.note.trim() !== "";
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * The largest picture that still goes to the agent inline (the API takes 5 MB of base64 per
 * image; 3.75 MB of bytes is that once encoded).
 */
export const INLINE_IMAGE_LIMIT = 3.75 * 1024 * 1024;

/** The JPEG qualities tried, best first, when the PNG is too big. */
export const JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5] as const;

export type Encode = (type: "image/png" | "image/jpeg", quality?: number) => Promise<Blob>;

/**
 * The annotated picture as a PNG, or when that's over `limit` as the best JPEG that fits (none
 * fits: the smallest one tried, and the service decides what to do with it).
 */
export async function encodeWithinLimit(encode: Encode, limit = INLINE_IMAGE_LIMIT): Promise<Blob> {
  const png = await encode("image/png");
  if (png.size <= limit) return png;
  let smallest: Blob = png;
  for (const q of JPEG_QUALITIES) {
    const jpeg = await encode("image/jpeg", q);
    if (jpeg.size <= limit) return jpeg;
    if (jpeg.size < smallest.size) smallest = jpeg;
  }
  return smallest;
}

/** A file's name without its extension ("Shot 2.png" → "Shot 2"; a name without one stays as is). */
export function stripExtension(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? "";
  return leaf.replace(/\.[A-Za-z][A-Za-z0-9]{0,4}$/, "");
}

/** The file name of the annotated picture: `annotated-<base>.png` (or .jpg), the base made safe for a file name. */
export function annotatedName(base: string, mimeType: string): string {
  const ext = mimeType === "image/jpeg" ? "jpg" : "png";
  const safe = base.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
  return `annotated-${safe || "image"}.${ext}`;
}

/** A browser page's name for its picture: the host, else the title, else "page". */
export function browserShotName(url: string, title: string): string {
  try {
    const host = new URL(url).hostname;
    if (host) return host;
  } catch {}
  return title.trim() || "page";
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Whether the lightbox offers Annotate for the item it shows: only inside a ticket that can take
 * messages (`scoped`), for an image (not a video) that loaded, and only where the caller says
 * where it came from.
 */
export function offersAnnotate(o: { scoped: boolean; kind: "image" | "video"; failed: boolean; hasSource: boolean }): boolean {
  return o.scoped && o.kind === "image" && !o.failed && o.hasSource;
}
