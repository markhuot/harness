// Annotations (DESIGN.md "Annotations"): numbered notes a human draws on an image sent with a
// message. The image file already has the numbers and arrows drawn into it; the marks come along
// as data too, so the agent reads each note next to the exact pixel it points at.

import { closeSync, openSync, readSync } from "node:fs";
import {
  MAX_ANNOTATION_MARKS,
  MAX_ANNOTATION_MESSAGE,
  type AnnotationMark,
  type AnnotationSource,
  type MessageAnnotation,
  type PromptAttachment,
} from "@harness/shared";
import { badRequest } from "./orchestrator/errors";
import { sniffImage } from "./prompt-attachments";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Whether an attachment is an image the agent can be shown: by its first bytes, else (unreadable) its name. */
function isImage(a: PromptAttachment): boolean {
  try {
    const fd = openSync(a.path, "r");
    try {
      const head = Buffer.alloc(16);
      const n = readSync(fd, head, 0, 16, 0);
      return sniffImage(head.subarray(0, n)) !== null;
    } finally {
      closeSync(fd);
    }
  } catch {
    const ext = /\.([^./]+)$/.exec(a.name)?.[1] ?? /\.([^./]+)$/.exec(a.path)?.[1];
    return !!ext && IMAGE_EXTENSIONS.has(ext.toLowerCase());
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const indexInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function source(raw: unknown, at: string): AnnotationSource {
  if (!isObject(raw)) throw badRequest(`${at}: source is required`);
  const name = (): string => {
    if (typeof raw.name !== "string") throw badRequest(`${at}: source.name must be a string`);
    return raw.name;
  };
  switch (raw.kind) {
    case "attachment":
      if (typeof raw.id !== "string" || !raw.id) throw badRequest(`${at}: an attachment source needs its id`);
      return { kind: "attachment", id: raw.id, name: name() };
    case "prompt-attachment":
      if (!indexInt(raw.index)) throw badRequest(`${at}: a prompt-attachment source needs its index`);
      return { kind: "prompt-attachment", index: raw.index, name: name() };
    case "message-attachment":
      if (typeof raw.entryId !== "string" || !raw.entryId) throw badRequest(`${at}: a message-attachment source needs its entryId`);
      if (!indexInt(raw.index)) throw badRequest(`${at}: a message-attachment source needs its index`);
      return { kind: "message-attachment", entryId: raw.entryId, index: raw.index, name: name() };
    case "browser": {
      if (typeof raw.url !== "string" || !raw.url) throw badRequest(`${at}: a browser source needs its url`);
      if (typeof raw.title !== "string") throw badRequest(`${at}: a browser source's title must be a string`);
      if (!positiveInt(raw.tabId)) throw badRequest(`${at}: a browser source needs its tabId`);
      const vp = raw.viewport;
      if (!isObject(vp) || !positive(vp.width) || !positive(vp.height)) throw badRequest(`${at}: a browser source needs its viewport { width, height }`);
      if (!positive(raw.scale)) throw badRequest(`${at}: a browser source's scale must be a positive number`);
      return { kind: "browser", url: raw.url, title: raw.title, tabId: raw.tabId, viewport: { width: vp.width, height: vp.height }, scale: raw.scale };
    }
    default:
      throw badRequest(`${at}: source.kind must be attachment, prompt-attachment, message-attachment or browser`);
  }
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
 * Validate a message's annotations (MessageBody.annotations) against the attachments sent with it,
 * and return a clean copy (known fields only, messages trimmed). Throws a 400 on anything
 * malformed: each entry names one image among `attachments`, at most once, with 1…MAX marks
 * numbered in order, every point inside the image.
 */
export function normalizeAnnotations(raw: unknown, attachments: readonly PromptAttachment[]): MessageAnnotation[] {
  if (!Array.isArray(raw)) throw badRequest("annotations must be a list");
  const seen = new Set<number>();
  return raw.map((item, k): MessageAnnotation => {
    const at = `annotations[${k}]`;
    if (!isObject(item)) throw badRequest(`${at}: must be { attachment, source, width, height, marks }`);
    const index = item.attachment;
    if (!indexInt(index) || index >= attachments.length) throw badRequest(`${at}: attachment must be the index of a file sent with the message`);
    if (seen.has(index)) throw badRequest(`${at}: attachment ${index} is annotated twice`);
    seen.add(index);
    const file = attachments[index]!;
    if (!isImage(file)) throw badRequest(`${at}: ${file.name} isn't a PNG, JPEG, GIF or WebP image`);
    const { width, height } = item;
    if (!positiveInt(width) || !positiveInt(height)) throw badRequest(`${at}: width and height must be positive whole numbers of pixels`);
    if (!Array.isArray(item.marks) || item.marks.length === 0) throw badRequest(`${at}: marks must list at least one note`);
    if (item.marks.length > MAX_ANNOTATION_MARKS) throw badRequest(`${at}: at most ${MAX_ANNOTATION_MARKS} marks`);
    return {
      attachment: index,
      source: source(item.source, at),
      width,
      height,
      marks: item.marks.map((m, i) => mark(m, i, width, height, at)),
    };
  });
}

const fmt = (n: number) => String(Number(n.toFixed(2)));
const px = (x: number, y: number) => `(${Math.round(x)}, ${Math.round(y)})`;
const pct = (v: number, of: number) => `${Math.round((v / of) * 100)}%`;

function origin(s: AnnotationSource): string {
  switch (s.kind) {
    case "attachment":
      return `the spec image "${s.name}"`;
    case "prompt-attachment":
      return `the ticket's attached file "${s.name}"`;
    case "message-attachment":
      return `the file "${s.name}" sent with an earlier message`;
    case "browser":
      return `a screenshot of browser tab ${s.tabId}, "${s.title}" at ${s.url} (viewport ${fmt(s.viewport.width)}×${fmt(s.viewport.height)} CSS px at ${fmt(s.scale)}× scale)`;
  }
}

function markLine(m: AnnotationMark, a: MessageAnnotation): string {
  const s = a.source;
  const css = (x: number, y: number) => (s.kind === "browser" ? ` = ${px(x / s.scale, y / s.scale)} CSS px` : "");
  const where = `${px(m.x, m.y)} px${css(m.x, m.y)}, ${pct(m.x, a.width)} across, ${pct(m.y, a.height)} down`;
  const arrow = m.tailX !== undefined && m.tailY !== undefined ? `, arrow from ${px(m.tailX, m.tailY)} px${css(m.tailX, m.tailY)}` : "";
  const note = m.message ? m.message.replace(/\r?\n/g, "\n   ") : "(no note)";
  return `${m.n}. ${where}${arrow}: ${note}`;
}

/**
 * What the agent reads about a message's annotations: one paragraph per annotated image (its
 * path, size and where it came from) and one line per numbered note, with the point it marks.
 * Goes in the prompt before the `<attachments>` block. Empty when there are none.
 */
export function formatAnnotations(annotations: readonly MessageAnnotation[] | undefined, attachments: readonly PromptAttachment[]): string {
  if (!annotations?.length) return "";
  const blocks = annotations.map((a) => {
    const file = attachments[a.attachment];
    const head = `${file?.path ?? `attachment ${a.attachment}`} (${a.width}×${a.height} px) is ${origin(a.source)}. The human drew the numbered notes below onto it.`;
    const note = a.source.kind === "browser" ? "\nPoints are in the image's pixels, then in the page's CSS pixels (what browser tools and page coordinates use)." : "";
    return [head + note, ...a.marks.map((m) => markLine(m, a))].join("\n");
  });
  return [
    "",
    "",
    "<annotations>",
    "Each number on an annotated image is a note. A note with an arrow points from its number at the spot listed; one without sits on that spot. (x, y) counts from the image's top-left corner.",
    "",
    blocks.join("\n\n"),
    "</annotations>",
  ].join("\n");
}
