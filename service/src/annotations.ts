// Annotations (DESIGN.md "Annotations"): numbered notes a human draws on an image attachment.
// They're metadata on the attachment (Attachment.annotation); the image file is never
// changed. The service checks their shape here and writes what the agent reads about them, so it
// reads each note next to the exact pixel it points at.

import { MAX_ANNOTATION_MARKS, MAX_ANNOTATION_MESSAGE, type AnnotationMark, type AnnotationPage, type AttachmentAnnotation } from "@harness/shared";
import { badRequest } from "./orchestrator/errors";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function page(raw: unknown, at: string): AnnotationPage {
  if (!isObject(raw)) throw badRequest(`${at}: page must be { url, title, tabId, viewport, scale }`);
  if (typeof raw.url !== "string" || !raw.url) throw badRequest(`${at}: page needs its url`);
  if (typeof raw.title !== "string") throw badRequest(`${at}: page.title must be a string`);
  if (!positiveInt(raw.tabId)) throw badRequest(`${at}: page needs its tabId`);
  const vp = raw.viewport;
  if (!isObject(vp) || !positive(vp.width) || !positive(vp.height)) throw badRequest(`${at}: page needs its viewport { width, height }`);
  if (!positive(raw.scale)) throw badRequest(`${at}: page.scale must be a positive number`);
  return { url: raw.url, title: raw.title, tabId: raw.tabId, viewport: { width: vp.width, height: vp.height }, scale: raw.scale };
}

function mark(raw: unknown, i: number, width: number, height: number, at: string): AnnotationMark {
  const here = `${at}, mark ${i + 1}`;
  if (!isObject(raw)) throw badRequest(`${here}: must be { n, x, y, tailX?, tailY?, message }`);
  if (raw.n !== i + 1) throw badRequest(`${here}: marks must be numbered 1, 2, 3… in order`);
  const inside = (x: unknown, y: unknown, what: string) => {
    if (!finite(x) || !finite(y) || x < 0 || x > width || y < 0 || y > height) throw badRequest(`${here}: ${what} must be inside the ${width}×${height} image`);
  };
  inside(raw.x, raw.y, "the point");
  const hasTailX = raw.tailX !== undefined && raw.tailX !== null;
  const hasTailY = raw.tailY !== undefined && raw.tailY !== null;
  if (hasTailX !== hasTailY) throw badRequest(`${here}: tailX and tailY go together`);
  if (hasTailX) inside(raw.tailX, raw.tailY, "the arrow's start");
  if (typeof raw.message !== "string") throw badRequest(`${here}: message must be a string`);
  const message = raw.message.trim();
  if (message.length > MAX_ANNOTATION_MESSAGE) throw badRequest(`${here}: message is over ${MAX_ANNOTATION_MESSAGE} characters`);
  return {
    n: i + 1,
    x: raw.x as number,
    y: raw.y as number,
    ...(hasTailX ? { tailX: raw.tailX as number, tailY: raw.tailY as number } : {}),
    message,
  };
}

/**
 * Check one attachment's annotation and return a clean copy (known fields only, messages
 * trimmed). Throws a 400 on anything malformed: a positive whole-pixel size, 1…MAX marks numbered
 * in order with every point inside the image, an arrow's tail given whole or not at all, and a
 * well-formed page when there is one. Whether the file is an image is the caller's to check.
 */
export function normalizeAnnotation(raw: unknown, at: string): AttachmentAnnotation {
  if (!isObject(raw)) throw badRequest(`${at}: annotation must be { width, height, marks, page? }`);
  const { width, height } = raw;
  if (!positiveInt(width) || !positiveInt(height)) throw badRequest(`${at}: annotation width and height must be positive whole numbers of pixels`);
  if (!Array.isArray(raw.marks) || raw.marks.length === 0) throw badRequest(`${at}: annotation marks must list at least one note`);
  if (raw.marks.length > MAX_ANNOTATION_MARKS) throw badRequest(`${at}: at most ${MAX_ANNOTATION_MARKS} annotation marks`);
  return {
    width,
    height,
    marks: raw.marks.map((m, i) => mark(m, i, width, height, at)),
    ...(raw.page !== undefined && raw.page !== null ? { page: page(raw.page, at) } : {}),
  };
}

const fmt = (n: number) => String(Number(n.toFixed(2)));
const px = (x: number, y: number) => `(${Math.round(x)}, ${Math.round(y)})`;
const pct = (v: number, of: number) => `${Math.round((v / of) * 100)}%`;

/** Said once in an `<attachments>` block that has an annotated image. */
export const ANNOTATIONS_INTRO =
  "The human drew numbered notes on some images; each one's notes are listed under it. A note with an arrow points from its number at the spot listed; one without sits on that spot. (x, y) counts from the image's top-left corner.";

/**
 * What the agent reads about one annotated image, to go under its path: a line on its size (and,
 * for a browser screenshot, the page it shows), then one line per numbered note with the point it
 * marks, in the image's pixels, as a share of the image, and in the page's CSS pixels for a page.
 */
export function annotationLines(a: AttachmentAnnotation): string[] {
  const p = a.page;
  const css = (x: number, y: number) => (p ? ` = ${px(x / p.scale, y / p.scale)} CSS px` : "");
  const head = p
    ? `A screenshot of browser tab ${p.tabId} "${p.title}" ${p.url} (viewport ${fmt(p.viewport.width)}×${fmt(p.viewport.height)} CSS px at ${fmt(p.scale)}× scale), ${a.width}×${a.height} px. Points are in the image's pixels, then in the page's CSS pixels (what browser tools and page coordinates use). Notes:`
    : `${a.width}×${a.height} px. Notes:`;
  const marks = a.marks.map((m) => {
    const where = `${px(m.x, m.y)} px${css(m.x, m.y)}, ${pct(m.x, a.width)} across, ${pct(m.y, a.height)} down`;
    const arrow = m.tailX !== undefined && m.tailY !== undefined ? `, arrow from ${px(m.tailX, m.tailY)} px${css(m.tailX, m.tailY)}` : "";
    const note = m.message ? m.message.replace(/\r?\n/g, "\n   ") : "(no note)";
    return `${m.n}. ${where}${arrow}: ${note}`;
  });
  return [head, ...marks];
}

/** The notes as get_ticket lists them: one compact line each with the pixel it marks. */
export function compactNotes(a: AttachmentAnnotation): string[] {
  return a.marks.map((m) => `${m.n}. (${Math.round(m.x)}, ${Math.round(m.y)}) px: ${m.message || "(no note)"}`);
}
