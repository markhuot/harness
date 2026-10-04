// The annotator's pure rules (components/Annotator.tsx, DESIGN.md "Annotations"): its undo history,
// how the annotated picture is encoded so it can go to the agent inline, what the file is called,
// which lightbox items offer Annotate, and how an annotated picture takes its place in a message's
// (or a New session's) attachments. No React or DOM, so they're tested on their own.

import type { AnnotationSource, MessageAnnotation, PromptAttachment } from "@harness/shared";
import { withAnnotation, type DraftMark } from "@harness/shared/state";

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
 * Whether closing loses work, so Cancel and Esc ask first: there are marks, and they aren't the
 * ones the annotator opened with (reopening a picture to edit and closing it untouched loses nothing).
 */
export function hasAnnotatorWork(marks: readonly DraftMark[], initial: readonly DraftMark[] = []): boolean {
  return marks.length > 0 && JSON.stringify(marks) !== JSON.stringify(initial);
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

/** The base of the annotated picture's name for what it came from (re-annotating keeps the first one's). */
export function sourceBaseName(source: AnnotationSource): string {
  return source.kind === "browser" ? browserShotName(source.url, source.title) : stripExtension(source.name);
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
 * Whether the lightbox offers Annotate for the item it shows: only where there's a message to add
 * the picture to (`scoped`: a ticket's composer, a New session), for an image (not a video) that
 * loaded, and only where the caller offers it (says where it came from).
 */
export function offersAnnotate(o: { scoped: boolean; kind: "image" | "video"; failed: boolean; offered: boolean }): boolean {
  return o.scoped && o.kind === "image" && !o.failed && o.offered;
}

// ---------------------------------------------------------------------------
// The annotated picture in a message
// ---------------------------------------------------------------------------

/** What was annotated, kept in memory so the picture can be reopened with its marks to edit them. */
export interface AnnotatedOriginal {
  /** The image before any marks were burned in. */
  blob: Blob;
  marks: DraftMark[];
}

/** What Add to message hands its target: the uploaded picture, its notes, and what it was made from. */
export interface AnnotatedImage {
  attachment: PromptAttachment;
  annotation: Omit<MessageAnnotation, "attachment">;
  original: AnnotatedOriginal;
}

/** A list of attachments with the notes on its images (a message waiting in the composer, a New session). */
export interface AnnotatedList {
  attachments: PromptAttachment[];
  annotations: MessageAnnotation[];
}

/**
 * The notes of `before` for the files that are still in `after`, re-pointed at their new places
 * (files are told apart by path, which a list never has twice). Whatever changed the list (a
 * removal, a send that took some of the files, files added at the end), the notes stay on their
 * pictures, and the notes of a file that left go with it.
 */
export function carryAnnotations(before: readonly PromptAttachment[], after: readonly PromptAttachment[], annotations: readonly MessageAnnotation[]): MessageAnnotation[] {
  const at = new Map(after.map((a, i) => [a.path, i]));
  const out: MessageAnnotation[] = [];
  for (const a of annotations) {
    const file = before[a.attachment];
    const i = file ? at.get(file.path) : undefined;
    if (i !== undefined) out.push({ ...a, attachment: i });
  }
  return out.sort((x, y) => x.attachment - y.attachment);
}

/**
 * `list` with an annotated picture in it: in the place of the file at `replacePath` (re-annotating a
 * picture that was waiting there), or at the end when there's no such file (any more). Null when
 * it would go at the end of a list that already has `max` files.
 */
export function withAnnotatedImage(list: AnnotatedList, image: Pick<AnnotatedImage, "attachment" | "annotation">, replacePath: string | null, max: number): AnnotatedList | null {
  const at = replacePath === null ? -1 : list.attachments.findIndex((a) => a.path === replacePath);
  if (at < 0) {
    if (list.attachments.length >= max) return null;
    const attachments = [...list.attachments, image.attachment];
    return { attachments, annotations: withAnnotation(list.annotations, attachments.length - 1, image.annotation) };
  }
  const attachments = list.attachments.map((a, i) => (i === at ? image.attachment : a));
  return { attachments, annotations: withAnnotation(list.annotations, at, image.annotation) };
}

/** Where a file waiting in a message came from, for its notes: the first annotation's source when it was annotated already, else the file itself. */
export function pendingSource(annotations: readonly MessageAnnotation[], index: number, file: Pick<PromptAttachment, "name">): AnnotationSource {
  return annotations.find((a) => a.attachment === index)?.source ?? { kind: "file", name: file.name };
}
