// Attachment lists (DESIGN.md "Attachments"): the files a human attaches to a New session or a
// message, each one an Attachment the service registered (an upload, a registered file, a spec
// image, a file from an earlier message), with its annotation if any. The pure pieces both apps
// use: the list a draft or composer keeps, what a create, PATCH or message sends, and which files
// get an image preview. Platform-independent: no React, DOM or native APIs.

import { MAX_PROMPT_ATTACHMENTS, type Attachment, type AttachmentAnnotation, type AttachmentInput } from "../protocol";
import { sameAnnotation } from "./annotations";

/** The last path component: "/a/b/shot.png" → "shot.png". */
export function fileBaseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tiff"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);

/** A kind guessed from a file name, for an input the service hasn't described yet. */
function kindByName(name: string): Attachment["kind"] {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext) ? "image" : VIDEO_EXTENSIONS.has(ext) ? "video" : "file";
}

/**
 * An input as a list keeps it: a full Attachment stays as it is; a bare `{ id }` or `{ path }` gets
 * the defaults the service would fill in (its name from the path, its kind from the name). Applied
 * to a draft's own PATCH before the service answers.
 */
export function attachmentFromInput(a: AttachmentInput): Attachment {
  const path = a.path ?? "";
  const name = a.name?.trim() || fileBaseName(path) || "file";
  const out: Attachment = {
    id: a.id ?? "",
    path,
    name,
    source: a.source ?? "file",
    kind: a.kind ?? kindByName(name || path),
    mimeType: a.mimeType ?? "",
  };
  if (a.size !== undefined) out.size = a.size;
  if (a.width !== undefined) out.width = a.width;
  if (a.height !== undefined) out.height = a.height;
  if (a.annotation) out.annotation = a.annotation;
  return out;
}

/** The list as a create, PATCH or message body sends it: each attachment whole (the service reads its id, name and annotation). */
export function attachmentInputs(list: readonly Attachment[]): AttachmentInput[] {
  return list.map((a) => ({ ...a }));
}

/** Same attachments, same names, same annotations, same order. */
export function sameAttachments(a: readonly Attachment[], b: readonly Attachment[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.path === b[i]!.path && x.name === b[i]!.name && sameAnnotation(x.annotation, b[i]!.annotation));
}

/** The same file: by id once the service has registered it, else by path. */
const sameFile = (a: Pick<Attachment, "id" | "path">, b: Pick<Attachment, "id" | "path">) => (a.id && b.id ? a.id === b.id : a.path === b.path);

/**
 * `list` with `added` appended: a file already in the list (or twice in `added`) is attached once,
 * and nothing goes past `max`. `skipped` counts what was left out for the limit, so the editor can
 * say so.
 */
export function addAttachments(list: readonly Attachment[], added: readonly Attachment[], max = MAX_PROMPT_ATTACHMENTS): { list: Attachment[]; skipped: number } {
  const out = [...list];
  let skipped = 0;
  for (const a of added) {
    if (out.some((x) => sameFile(x, a))) continue;
    if (out.length >= max) {
      skipped++;
      continue;
    }
    out.push(a);
  }
  return { list: out, skipped };
}

/**
 * `list` with `attachment` annotated (DESIGN.md "Annotations"): the same file already in the list
 * gets the annotation in place (null takes it off), or `attachment` is added at the end with it.
 * `skipped` is true when it wasn't there and the list was already full.
 */
export function annotateAttachment(
  list: readonly Attachment[],
  attachment: Attachment,
  annotation: AttachmentAnnotation | null,
  max = MAX_PROMPT_ATTACHMENTS,
): { list: Attachment[]; skipped: boolean } {
  const set = (a: Attachment): Attachment => {
    const { annotation: _old, ...rest } = a;
    return annotation ? { ...rest, annotation } : rest;
  };
  const i = list.findIndex((a) => sameFile(a, attachment));
  if (i >= 0) return { list: list.map((a, j) => (j === i ? set(a) : a)), skipped: false };
  if (list.length >= max) return { list: [...list], skipped: true };
  return { list: [...list, set(attachment)], skipped: false };
}

/** `list` without the attachment at `index` (unchanged when there's none). */
export function removeAttachment(list: readonly Attachment[], index: number): Attachment[] {
  return list.filter((_, i) => i !== index);
}

/** Whether the apps draw an image preview for it (and offer Annotate); other files show as a named chip. */
export function attachmentIsImage(a: Pick<Attachment, "kind">): boolean {
  return a.kind === "image";
}

const PASTE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
};

/** The file name a pasted image is uploaded as: "Pasted image.png", by its MIME type (png when unknown). */
export function pastedImageName(mimeType: string | null | undefined): string {
  return `Pasted image.${PASTE_EXTENSIONS[(mimeType ?? "").toLowerCase()] ?? "png"}`;
}
