// Ticket attachments (DESIGN.md "Spec revisions and attachments"): images and videos an agent's
// spec points at (`![After](shots/after.png)` in update_spec / edit_spec). Files are validated up
// front, then copied into $HARNESS_HOME/attachments/<id>.<ext>, since the agent's worktree is
// deleted after the merge, and the spec's src becomes attachment:<id>.

import { closeSync, copyFileSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { AttachmentKind, Attachment } from "@harness/shared";
import { newId } from "./store/util";

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

interface FileType {
  kind: AttachmentKind;
  mimeType: string;
  /** Extension the stored copy gets */
  ext: string;
  /** Whether the first bytes of the file look like this type */
  magic(head: Buffer): boolean;
}

const ascii = (head: Buffer, at: number, s: string) => head.subarray(at, at + s.length).toString("latin1") === s;

const PNG: FileType = { kind: "image", mimeType: "image/png", ext: "png", magic: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) };
const JPEG: FileType = { kind: "image", mimeType: "image/jpeg", ext: "jpg", magic: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff };
const GIF: FileType = { kind: "image", mimeType: "image/gif", ext: "gif", magic: (h) => ascii(h, 0, "GIF87a") || ascii(h, 0, "GIF89a") };
const WEBP: FileType = { kind: "image", mimeType: "image/webp", ext: "webp", magic: (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WEBP") };
const MP4: FileType = { kind: "video", mimeType: "video/mp4", ext: "mp4", magic: (h) => ascii(h, 4, "ftyp") };
const WEBM: FileType = { kind: "video", mimeType: "video/webm", ext: "webm", magic: (h) => h.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) };
// QuickTime files usually open with an ftyp box; older ones start straight with a top-level atom.
const MOV: FileType = { kind: "video", mimeType: "video/quicktime", ext: "mov", magic: (h) => ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].some((a) => ascii(h, 4, a)) };

const BY_EXT: Record<string, FileType> = { png: PNG, jpg: JPEG, jpeg: JPEG, gif: GIF, webp: WEBP, mp4: MP4, webm: WEBM, mov: MOV };
const BY_MIME: Record<string, FileType> = Object.fromEntries(Object.values(BY_EXT).map((t) => [t.mimeType, t]));

export const ALLOWED_EXTENSIONS = Object.keys(BY_EXT);

/** A validated file, ready to copy in. `id` is the attachment's id and stored file name; `from` is the file to copy. */
export interface PreparedAttachment extends Omit<Attachment, "path" | "source"> {
  from: string;
}

/** Where an attachment's copy lives. */
export function attachmentPath(dir: string, a: Pick<Attachment, "id" | "mimeType">): string {
  return join(dir, `${a.id}.${BY_MIME[a.mimeType]?.ext ?? "bin"}`);
}

/** The first `n` bytes of a file. */
function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Pixel size from an image header, when the header has it within `head`. */
export function imageSize(type: string, head: Buffer): { width: number; height: number } | null {
  if (type === "image/png" && head.length >= 24 && ascii(head, 12, "IHDR")) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  if (type === "image/gif" && head.length >= 10) {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  if (type === "image/webp" && head.length >= 30) {
    if (ascii(head, 12, "VP8X")) return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) };
    if (ascii(head, 12, "VP8 ") && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a) {
      return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
    }
    if (ascii(head, 12, "VP8L") && head[20] === 0x2f) {
      const bits = head.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (type === "image/jpeg") {
    // Walk the segments to the first start-of-frame marker (SOF0–SOF15, minus DHT/JPG/DAC).
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) return null;
      const marker = head[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = head.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

const HEAD_BYTES = 64 * 1024; // enough for a JPEG's EXIF block before its frame header, usually

/**
 * Validate every path before anything is stored: at most MAX_ATTACHMENTS, each an existing file of
 * an allowed type (by extension, confirmed by its first bytes) no larger than MAX_ATTACHMENT_BYTES.
 * Relative paths resolve against `cwd`. Throws an Error naming the first bad path.
 */
export function prepareAttachments(paths: unknown, cwd: string): PreparedAttachment[] {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) throw new Error("attachments must be a list of file paths");
  const list = (paths as string[]).map((p) => p.trim());
  if (list.length > MAX_ATTACHMENTS) throw new Error(`Too many attachments: ${list.length} (at most ${MAX_ATTACHMENTS} new ones per spec write)`);
  return list.map((given) => {
    if (!given) throw new Error("An attachment path is empty");
    const source = isAbsolute(given) ? given : resolve(cwd, given);
    const ext = extname(source).slice(1).toLowerCase();
    const type = BY_EXT[ext];
    if (!type) throw new Error(`Unsupported attachment type: ${given} (allowed: ${ALLOWED_EXTENSIONS.join(", ")})`);
    let size: number;
    try {
      const st = statSync(source);
      if (!st.isFile()) throw new Error(`Attachment is not a file: ${given}`);
      size = st.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Attachment not found: ${given} (looked at ${source})`);
      throw err;
    }
    if (size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment too large: ${given} is ${(size / 1024 / 1024).toFixed(1)} MB (at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
    const head = readHead(source, HEAD_BYTES);
    if (!type.magic(head)) throw new Error(`Attachment ${given} is not a valid .${ext} file (its contents don't match the extension)`);
    const dims = type.kind === "image" ? imageSize(type.mimeType, head) : null;
    return {
      id: newId(),
      kind: type.kind,
      mimeType: type.mimeType,
      name: basename(source),
      size,
      ...(dims && dims.width > 0 && dims.height > 0 ? dims : {}),
      from: source,
    };
  });
}

/**
 * Copy prepared files into `dir`, as spec media (source "spec", `path` the stored copy). On a
 * failure the copies made so far are removed.
 */
export function storeAttachments(dir: string, prepared: PreparedAttachment[]): Attachment[] {
  if (prepared.length === 0) return [];
  mkdirSync(dir, { recursive: true });
  const done: string[] = [];
  try {
    for (const p of prepared) {
      const dest = attachmentPath(dir, p);
      copyFileSync(p.from, dest);
      done.push(dest);
    }
  } catch (err) {
    removeAttachmentFiles(done);
    throw err;
  }
  return prepared.map(({ from: _from, ...a }) => ({ ...a, path: attachmentPath(dir, a), source: "spec" as const }));
}

/** What a file is, for registering it: a PNG, JPEG, GIF or WebP image or an MP4, WebM or QuickTime video by its first bytes, else a "file". */
export interface FileDescription {
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

const IMAGE_TYPES = [PNG, JPEG, GIF, WEBP];

/**
 * Describe a file on disk (null when it isn't a regular file, or can't be read). Images are
 * recognized by their first bytes whatever their name; videos need a video extension too, since
 * an ftyp box also opens HEIC images. Anything else is a "file" with the MIME type its name
 * suggests ("" when it suggests none).
 */
export function describeFile(path: string): FileDescription | null {
  let size: number;
  let head: Buffer;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    size = st.size;
    head = readHead(path, HEAD_BYTES);
  } catch {
    return null;
  }
  const image = IMAGE_TYPES.find((t) => t.magic(head));
  if (image) {
    const dims = imageSize(image.mimeType, head);
    return { kind: "image", mimeType: image.mimeType, size, ...(dims && dims.width > 0 && dims.height > 0 ? dims : {}) };
  }
  const ext = extname(path).slice(1).toLowerCase();
  const video = ext === "m4v" ? MP4 : BY_EXT[ext];
  if (video?.kind === "video" && video.magic(head)) return { kind: "video", mimeType: video.mimeType, size };
  const guessed = Bun.file(path).type.split(";")[0]!.trim();
  return { kind: "file", mimeType: guessed === "application/octet-stream" ? "" : guessed, size };
}

/** Best-effort removal of stored attachment files. */
export function removeAttachmentFiles(files: string[]) {
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {
      // already gone
    }
  }
}
