// Attachment lists (DESIGN.md "Attachments"): the files a human attaches to a New session or a
// message, each a registered Attachment (store/attachments.ts). Files already on disk are
// referenced where they are; uploads (pastes, anything from the iPhone/iPad) are written once to
// $HARNESS_HOME/uploads/<id>/<name> and kept until the last ticket using them is deleted. Either
// kind can go missing later, which every reader here allows for.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_PROMPT_ATTACHMENTS, type Attachment, type AttachmentInput, type AttachmentSource } from "@harness/shared";
import { describeFile } from "./attachments";
import { newId } from "./store/util";
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

/** Store uploaded bytes as uploads/<id>/<name> and describe them as an attachment (registered by the caller). */
export function storeUpload(uploadsDir: string, bytes: Uint8Array, rawName: string | null, mimeType: string | null): Attachment {
  if (bytes.byteLength === 0) throw new HarnessError(400, "The upload is empty");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HarnessError(413, `The upload is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const name = safeUploadName(rawName, mimeType);
  const dir = join(uploadsDir, randomUUID());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  const described = describeFile(path) ?? { kind: "file" as const, mimeType: "", size: bytes.byteLength };
  // The client's MIME type names what the bytes can't (a PDF, a text file).
  const given = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (described.kind === "file" && !described.mimeType && given && given !== "application/octet-stream") described.mimeType = given;
  return { id: newId(), path, name, source: "upload", ...described };
}

/** Where registered attachments are looked up and added (the store's AttachmentRepo). */
export interface AttachmentRegistry {
  get(id: string): Attachment | null;
  getByPath(path: string, source: AttachmentSource): Attachment | null;
  add(ticketId: null, attachments: readonly Attachment[]): void;
}

/**
 * Register a file on the service's machine (an agent's or the CLI's path, a drop on the Mac):
 * `path` must be absolute and a file that exists now (400 otherwise). The same file registered
 * before is the same attachment: the row with that path and source is reused. A file in the
 * uploads folder is an "upload", one of a spec's stored media is that "spec" attachment, anything
 * else a "file" referenced in place. `name` (trimmed) names this use; the record keeps its own.
 */
export function registerFile(registry: AttachmentRegistry, uploadsDir: string, path: string, name?: string | null): Attachment {
  if (!isAbsolute(path)) throw new HarnessError(400, `An attachment's path must be absolute: ${path}`);
  const described = describeFile(path);
  if (!described) {
    if (existsSync(path)) throw new HarnessError(400, `Attachment isn't a file: ${path}`);
    throw new HarnessError(400, `Attachment not found: ${path}`);
  }
  const source: AttachmentSource = isUploadPath(uploadsDir, path) ? "upload" : registry.getByPath(path, "spec") ? "spec" : "file";
  let record = registry.getByPath(path, source);
  if (!record) {
    record = { id: newId(), path, name: basename(path), source, ...described };
    registry.add(null, [record]);
  }
  const trimmed = name?.trim();
  return trimmed ? { ...record, name: trimmed } : record;
}

/**
 * Turn a create, PATCH or message's attachments (AttachmentInput[]) into the list it stores: full
 * Attachment records, each with this use's name and annotation. An input names its file by `id`
 * (any registered attachment: a spec image, an upload, a registered file, a file from an earlier
 * message; 400 for an unknown id or a file that's gone) or by `path` (registered here, see
 * registerFile). `previous` is what the list holds now: an attachment it already has (by id, or by
 * path) is kept as it was even when its file is gone (a reopened draft shouldn't fail to save).
 * The same file listed twice is kept once.
 *
 * Each annotation (DESIGN.md "Annotations") is checked: the file must be an image by its first
 * bytes, except a kept one whose file has gone missing, whose annotation still has to be
 * well-formed.
 */
export function resolveAttachments(raw: unknown, previous: readonly Attachment[], registry: AttachmentRegistry, uploadsDir: string): Attachment[] {
  if (!Array.isArray(raw)) throw new HarnessError(400, "attachments must be a list of { id } or { path, name? }");
  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const [i, item] of (raw as AttachmentInput[]).entries()) {
    if (!item || typeof item !== "object") throw new HarnessError(400, "Each attachment needs an id or a path");
    if (item.id !== undefined && item.id !== null && typeof item.id !== "string") throw new HarnessError(400, "An attachment's id must be a string");
    if (item.path !== undefined && item.path !== null && typeof item.path !== "string") throw new HarnessError(400, "An attachment's path must be a string");
    const id = item.id || null;
    const path = item.path || null;
    if (!id && !path) throw new HarnessError(400, "Each attachment needs an id or a path");
    if (item.name !== undefined && item.name !== null && typeof item.name !== "string") throw new HarnessError(400, "An attachment's name must be a string");
    const name = item.name?.trim() || null;
    const at = `attachments[${i}] (${name ?? (path ? basename(path) : id)})`;
    const annotation = item.annotation === undefined || item.annotation === null ? undefined : normalizeAnnotation(item.annotation, at);
    const had = id ? previous.find((a) => a.id === id) : previous.find((a) => a.path === path);
    if (had) {
      if (seen.has(had.id)) continue;
      seen.add(had.id);
      // Kept as it was; a changed annotation is checked against the file while it's still there.
      if (annotation && attachmentFile(had)) mustBeImage(had.path, at);
      const { annotation: _old, ...rest } = had;
      out.push({ ...rest, name: name ?? had.name, ...(annotation ? { annotation } : {}) });
      continue;
    }
    let record: Attachment;
    if (id) {
      const found = registry.get(id);
      if (!found) throw new HarnessError(400, `Unknown attachment: ${id}`);
      if (!attachmentFile(found)) throw new HarnessError(400, `Attachment not found: ${found.name} (was at ${found.path})`);
      record = found;
    } else record = registerFile(registry, uploadsDir, path!);
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    if (annotation) mustBeImage(record.path, at);
    out.push({ ...record, name: name ?? record.name, ...(annotation ? { annotation } : {}) });
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
export function attachmentFile(a: Pick<Attachment, "path"> & { mimeType?: string }): { path: string; size: number; mimeType: string } | null {
  try {
    const st = statSync(a.path);
    if (!st.isFile()) return null;
    return { path: a.path, size: st.size, mimeType: a.mimeType || Bun.file(a.path).type.split(";")[0] || "application/octet-stream" };
  } catch {
    return null;
  }
}

/** The upload folders of a ticket's attachments, to delete with it. Never anything outside uploads/. */
export function uploadDirs(uploadsDir: string, list: readonly Pick<Attachment, "path" | "source">[]): string[] {
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
  missing: Attachment[];
  /** Images left out of the message (too big, or past the limit), still listed by path */
  notInline: { name: string; reason: string }[];
}

/**
 * What a ticket's first run gets for its prompt attachments: a block for the prompt listing every
 * path (the agent can open any of them with its file tools), and the images that can go inline.
 * Missing files are named in the block so the agent knows the human meant to send them.
 */
export function runAttachments(list: readonly Attachment[]): RunAttachments | null {
  if (!list.length) return null;
  const images: RunImage[] = [];
  const attached: string[] = [];
  const missing: Attachment[] = [];
  const notInline: { name: string; reason: string }[] = [];
  const lines: string[] = [];
  for (const a of list) {
    const file = attachmentFile(a);
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
