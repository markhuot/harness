// Prompt attachments (DESIGN.md "Prompt attachments"): files a human attaches to a New session.
// The pure pieces both apps use: turning what a client has into the list a draft keeps, the PATCH
// side of it, and which ones get an image preview. Platform-independent: no React, DOM or native APIs.

import { MAX_PROMPT_ATTACHMENTS, type PromptAttachment, type PromptAttachmentInput } from "../protocol";

/** The last path component: "/a/b/shot.png" → "shot.png". */
export function fileBaseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/** What a client sent, as the draft keeps it: the file's name when none was given, "file" unless it says otherwise. */
export function promptAttachmentFromInput(a: PromptAttachmentInput): PromptAttachment {
  return { path: a.path, name: a.name?.trim() || fileBaseName(a.path), source: a.source ?? "file" };
}

/** The list as a create or PATCH body sends it (the service decides `source` itself). */
export function promptAttachmentInputs(list: readonly PromptAttachment[]): PromptAttachmentInput[] {
  return list.map((a) => ({ path: a.path, name: a.name }));
}

/** Same files, same names, same order. */
export function samePromptAttachments(a: readonly PromptAttachment[], b: readonly PromptAttachment[]): boolean {
  return a.length === b.length && a.every((x, i) => x.path === b[i]!.path && x.name === b[i]!.name);
}

/**
 * `list` with `added` appended: a path already in the list (or twice in `added`) is attached once,
 * and nothing goes past `max`. `skipped` counts what was left out for the limit, so the editor can
 * say so.
 */
export function addPromptAttachments(
  list: readonly PromptAttachment[],
  added: readonly PromptAttachmentInput[],
  max = MAX_PROMPT_ATTACHMENTS,
): { list: PromptAttachment[]; skipped: number } {
  const out = [...list];
  const seen = new Set(list.map((a) => a.path));
  let skipped = 0;
  for (const a of added) {
    if (seen.has(a.path)) continue;
    if (out.length >= max) {
      skipped++;
      continue;
    }
    seen.add(a.path);
    out.push(promptAttachmentFromInput(a));
  }
  return { list: out, skipped };
}

/** `list` without the attachment at `index` (unchanged when there's none). */
export function removePromptAttachment(list: readonly PromptAttachment[], index: number): PromptAttachment[] {
  return list.filter((_, i) => i !== index);
}

const PREVIEW_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/** Whether the apps draw an image preview for it (from its extension); other files show as a named chip. */
export function promptAttachmentIsImage(a: Pick<PromptAttachment, "name" | "path">): boolean {
  const ext = /\.([^./]+)$/.exec(a.name)?.[1] ?? /\.([^./]+)$/.exec(a.path)?.[1];
  return !!ext && PREVIEW_EXTENSIONS.has(ext.toLowerCase());
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
