// Prompt attachments (DESIGN.md "Prompt attachments"): files a human attaches to a New session.
// Files already on disk are referenced where they are; uploads (pastes, anything from the
// iPhone/iPad) are written once to $HARNESS_HOME/uploads/<id>/<name> and kept until their ticket
// is deleted. Either kind can go missing later, which every reader here allows for.

import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_PROMPT_ATTACHMENTS, type PromptAttachment, type PromptAttachmentInput } from "@harness/shared";
import { HarnessError } from "./orchestrator/errors";
import { ANNOTATIONS_INTRO, annotationLines, normalizeAnnotation } from "./annotations";

/** Largest upload POST /uploads takes. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/**
 * Largest image sent to the agent inline. The Anthropic API refuses images over 5 MB once
 * base64-encoded, which is 3.75 MB of file.
 */
export const MAX_INLINE_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
/** Most images one run gets inline; the rest are listed by path only. */
export const MAX_INLINE_IMAGES = 10;
/** How old an upload no ticket refers to has to be before the startup sweep removes it. */
export const ORPHAN_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/**
 * A file name that is safe as one path component: the last component of what the client sent,
 * without control characters, at most 120 characters (the extension kept), with the MIME type's
 * extension added when it has none.
 */
export function safeUploadName(raw: string | null | undefined, mimeType?: string | null): string {
  let name = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").split(/[/\\]/).pop()!.trim();
  if (!name || name === "." || name === "..") name = "Attachment";
  if (name.startsWith(".")) name = `Attachment${name}`;
  const ext = MIME_EXTENSIONS[(mimeType ?? "").split(";")[0]!.trim().toLowerCase()];
  if (ext && !/\.[^.]+$/.test(name)) name = `${name}.${ext}`;
  if (name.length > 120) {
    const m = /(\.[^.]{1,10})$/.exec(name);
    const tail = m ? m[1]! : "";
    name = name.slice(0, 120 - tail.length) + tail;
  }
  return name;
}

/** Whether `path` is (lexically) inside `dir`. */
function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Whether `path` is an upload: a file in its own folder right under the uploads folder. */
export function isUploadPath(uploadsDir: string, path: string): boolean {
  if (!inside(uploadsDir, path)) return false;
  return relative(resolve(uploadsDir), resolve(path)).split(sep).length === 2;
}

/** Store uploaded bytes as uploads/<id>/<name> and describe them as an attachment. */
export function storeUpload(uploadsDir: string, bytes: Uint8Array, rawName: string | null, mimeType: string | null): PromptAttachment {
  if (bytes.byteLength === 0) throw new HarnessError(400, "The upload is empty");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HarnessError(413, `The upload is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const name = safeUploadName(rawName, mimeType);
  const dir = join(uploadsDir, randomUUID());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, name, source: "upload" };
}

/** A spec image of the ticket (`attachment:<id>`), resolved to its stored file, or null when it has none by that id. */
export type SpecImageLookup = (id: string) => { path: string; name: string } | null;

const SPEC_IMAGE_PREFIX = "attachment:";

/**
 * Validate a create, PATCH or message's attachments. `previous` is what the ticket has now: an
 * attachment it already had stays even when its file is gone (a reopened draft shouldn't fail to
 * save), and only new paths have to be absolute files that exist. A path listed twice is kept
 * once. The source is decided here, from where the file is.
 *
 * A path may be `attachment:<id>`, one of the ticket's own spec images (`specImage` looks it up;
 * without one, as for a ticket being created, it's refused): it's referenced where it's stored,
 * never copied. Each attachment's annotation (DESIGN.md "Annotations") is checked: the file must be
 * an image by its first bytes, except a kept one whose file has gone missing, whose annotation
 * still has to be well-formed.
 */
export function normalizePromptAttachments(raw: unknown, previous: readonly PromptAttachment[], uploadsDir: string, specImage?: SpecImageLookup): PromptAttachment[] {
  if (!Array.isArray(raw)) throw new HarnessError(400, "promptAttachments must be a list of { path, name? }");
  const known = new Map(previous.map((a) => [a.path, a]));
  const out: PromptAttachment[] = [];
  const seen = new Set<string>();
  for (const [i, item] of (raw as PromptAttachmentInput[]).entries()) {
    let path = item && typeof item === "object" && typeof item.path === "string" ? item.path : null;
    if (!path) throw new HarnessError(400, "Each prompt attachment needs a path");
    if (item.name !== undefined && typeof item.name !== "string") throw new HarnessError(400, "A prompt attachment's name must be a string");
    let name = item.name?.trim() || null;
    if (path.startsWith(SPEC_IMAGE_PREFIX)) {
      const id = path.slice(SPEC_IMAGE_PREFIX.length);
      if (!specImage) throw new HarnessError(400, `${path}: a new ticket has no spec images to attach`);
      const found = id ? specImage(id) : null;
      if (!found) throw new HarnessError(400, `${path} isn't one of this ticket's spec images`);
      path = found.path;
      name ??= found.name;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const at = `attachments[${i}] (${name ?? basename(path)})`;
    const annotation = item.annotation === undefined || item.annotation === null ? undefined : normalizeAnnotation(item.annotation, at);
    const had = known.get(path);
    if (had) {
      // Kept as it was; a changed annotation is checked against the file while it's still there.
      if (annotation && promptAttachmentFile(had)) mustBeImage(path, at);
      const { annotation: _old, ...rest } = had;
      out.push({ ...rest, name: name ?? had.name, ...(annotation ? { annotation } : {}) });
      continue;
    }
    if (!isAbsolute(path)) throw new HarnessError(400, `A prompt attachment's path must be absolute: ${path}`);
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new HarnessError(400, `Attachment not found: ${path}`);
    }
    if (!st.isFile()) throw new HarnessError(400, `Attachment isn't a file: ${path}`);
    if (annotation) mustBeImage(path, at);
    out.push({ path, name: name ?? basename(path), source: isUploadPath(uploadsDir, path) ? "upload" : "file", ...(annotation ? { annotation } : {}) });
  }
  if (out.length > MAX_PROMPT_ATTACHMENTS) throw new HarnessError(400, `At most ${MAX_PROMPT_ATTACHMENTS} attachments`);
  return out;
}

/** 400 unless the file is a PNG, JPEG, GIF or WebP by its first bytes (only images take notes). */
function mustBeImage(path: string, at: string): void {
  let type: RunImage["mediaType"] | null = null;
  try {
    type = sniffImage(readHead(path, 16));
  } catch {
    /* unreadable: not an image we can show */
  }
  if (!type) throw new HarnessError(400, `${at}: only a PNG, JPEG, GIF or WebP image can be annotated`);
}

/** The attachment's file when it's still there (a regular file), else null. */
export function promptAttachmentFile(a: Pick<PromptAttachment, "path">): { path: string; size: number; mimeType: string } | null {
  try {
    const st = statSync(a.path);
    if (!st.isFile()) return null;
    return { path: a.path, size: st.size, mimeType: Bun.file(a.path).type.split(";")[0] || "application/octet-stream" };
  } catch {
    return null;
  }
}

/** The upload folders of a ticket's attachments, to delete with it. Never anything outside uploads/. */
export function uploadDirs(uploadsDir: string, list: readonly PromptAttachment[]): string[] {
  return [...new Set(list.filter((a) => a.source === "upload" && isUploadPath(uploadsDir, a.path)).map((a) => dirname(resolve(a.path))))];
}

export function removeUploadDirs(dirs: readonly string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

/**
 * Remove upload folders no ticket refers to that are older than `maxAgeMs` (a paste taken back
 * out of a draft, or a draft discarded before its first save). Young ones are left alone: a
 * client may have just uploaded one and not saved the draft yet. Returns the folders removed.
 */
export function sweepUploads(uploadsDir: string, referenced: ReadonlySet<string>, maxAgeMs = ORPHAN_UPLOAD_AGE_MS, at = Date.now()): string[] {
  let entries: string[];
  try {
    entries = readdirSync(uploadsDir);
  } catch {
    return [];
  }
  const keep = new Set([...referenced].filter((p) => isUploadPath(uploadsDir, p)).map((p) => dirname(resolve(p))));
  const removed: string[] = [];
  for (const e of entries) {
    const dir = join(resolve(uploadsDir), e);
    if (keep.has(dir)) continue;
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || at - st.mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* gone already */
    }
  }
  return removed;
}

/** An image the agent gets inline in the run's first message. */
export interface RunImage {
  name: string;
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** The file, base64-encoded */
  data: string;
}

/** The inline image type of a file, by its first bytes (the extension can lie), or null. */
export function sniffImage(head: Uint8Array): RunImage["mediaType"] | null {
  const b = Buffer.from(head);
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const ascii = (at: number, s: string) => b.subarray(at, at + s.length).toString("latin1") === s;
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

function readHead(path: string, n: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

export interface RunAttachments {
  /** Appended to the run's prompt: every attachment's path, missing ones marked */
  block: string;
  images: RunImage[];
  /** Names attached (inline or by path), for the transcript's status line */
  attached: string[];
  /** Attachments whose file is gone */
  missing: PromptAttachment[];
  /** Images left out of the message (too big, or past the limit), still listed by path */
  notInline: { name: string; reason: string }[];
}

/**
 * What a ticket's first run gets for its prompt attachments: a block for the prompt listing every
 * path (the agent can open any of them with its file tools), and the images that can go inline.
 * Missing files are named in the block so the agent knows the human meant to send them.
 */
export function runAttachments(list: readonly PromptAttachment[]): RunAttachments | null {
  if (!list.length) return null;
  const images: RunImage[] = [];
  const attached: string[] = [];
  const missing: PromptAttachment[] = [];
  const notInline: { name: string; reason: string }[] = [];
  const lines: string[] = [];
  for (const a of list) {
    const file = promptAttachmentFile(a);
    const notes = a.annotation ? annotationLines(a.annotation).map((l) => `  ${l}`) : [];
    if (!file) {
      missing.push(a);
      lines.push(`- ${a.path} (missing: it was moved or deleted after it was attached)`, ...notes);
      continue;
    }
    attached.push(a.name);
    let inline = false;
    const type = sniffImage(readHead(a.path, 16));
    if (type) {
      if (file.size > MAX_INLINE_IMAGE_BYTES) notInline.push({ name: a.name, reason: `over ${(MAX_INLINE_IMAGE_BYTES / 1024 / 1024).toFixed(2)} MB` });
      else if (images.length >= MAX_INLINE_IMAGES) notInline.push({ name: a.name, reason: `more than ${MAX_INLINE_IMAGES} images` });
      else {
        try {
          images.push({ name: a.name, path: a.path, mediaType: type, data: Buffer.from(readAll(a.path)).toString("base64") });
          inline = true;
        } catch {
          notInline.push({ name: a.name, reason: "couldn't be read" });
        }
      }
    }
    lines.push(`- ${a.path}${inline ? " (image, included in this message)" : ""}`, ...notes);
  }
  const block = [
    "",
    "",
    "<attachments>",
    "The human attached these files to this request. Open any of them with your file tools; images marked as included are also in this message.",
    ...(list.some((a) => a.annotation) ? [ANNOTATIONS_INTRO] : []),
    ...lines,
    "</attachments>",
  ].join("\n");
  return { block, images, attached, missing, notInline };
}

function readAll(path: string): Uint8Array {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const got = readSync(fd, buf, off, size - off, off);
      if (got <= 0) break;
      off += got;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}
