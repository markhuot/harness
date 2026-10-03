// Prompt attachments on the Mac (DESIGN.md "Prompt attachments"): the pure decisions behind the
// draft editor's paperclip, drops and pastes, and the strip that shows them. A file that's on disk
// is attached by its path, never copied; anything else (pasted image data, an image dragged out of
// a browser) is uploaded to the service first. No React or DOM APIs beyond the File-like shape.

import type { PromptAttachment, PromptAttachmentInput } from "@harness/shared";
import { fileBaseName, pastedImageName } from "@harness/shared/state";

/** What the editor knows about a File it was handed: its name, MIME type and (from the preload) path on disk. */
export interface FileLike {
  name: string;
  type: string;
}

/** A batch of files, split into the ones attached in place and the ones that have to be uploaded. */
export interface FilePlan<F> {
  byPath: { input: PromptAttachmentInput; file: F }[];
  uploads: { file: F; name: string; mimeType: string }[];
  /** Pathless files that aren't worth uploading (a paste's non-image data) */
  ignored: number;
}

/**
 * Sort `files` by where they come from. `pathOf` is the preload's webUtils lookup (null for data
 * with no file behind it). With the service on this Mac (`local`), a file with a path is attached by
 * it. With a service on another machine that path means nothing there, so the file's bytes are
 * uploaded under its own name instead. A pathless one is uploaded: always for a drop or a pick
 * (`uploadAny`), and only when it's an image for a paste, so a paste of rich text that happens to
 * carry other data still pastes as text.
 */
export function planFiles<F extends FileLike>(files: readonly F[], pathOf: (f: F) => string | null, opts: { uploadAny: boolean; local: boolean }): FilePlan<F> {
  const plan: FilePlan<F> = { byPath: [], uploads: [], ignored: 0 };
  for (const file of files) {
    const path = pathOf(file);
    if (path && opts.local) {
      plan.byPath.push({ input: { path, name: file.name || undefined, source: "file" }, file });
      continue;
    }
    if (path) {
      // A file on this Mac, for a service elsewhere: its real name, whatever its type.
      plan.uploads.push({ file, name: file.name || fileBaseName(path), mimeType: file.type || "application/octet-stream" });
      continue;
    }
    const image = file.type.toLowerCase().startsWith("image/");
    if (!image && !opts.uploadAny) {
      plan.ignored++;
      continue;
    }
    // A pasted image comes in as "image.png"; give it the name the iPhone app gives one too.
    const name = image && (!file.name || /^image\.\w+$/i.test(file.name)) ? pastedImageName(file.type) : file.name || pastedImageName(file.type);
    plan.uploads.push({ file, name, mimeType: file.type || "application/octet-stream" });
  }
  return plan;
}

/** Whether the service at `baseUrl` runs on this Mac (a loopback host), so paths on disk mean the same there. */
export function isLocalService(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Whether a drag carries files from outside the page (Finder, a browser), not our own pane drags or text. */
export const isFileDrag = (types: readonly string[] | null | undefined) => !!types && Array.from(types).includes("Files");

/** The toast when the limit left some out, or null when everything fit. */
export function limitMessage(skipped: number, max: number): string | null {
  if (skipped <= 0) return null;
  return `${skipped === 1 ? "1 file wasn't" : `${skipped} files weren't`} attached: a session takes at most ${max}.`;
}

/** The label and tooltip of an attachment whose file is gone. */
export const missingLabel = (a: Pick<PromptAttachment, "path">) => `Missing — was at ${a.path}`;

/**
 * Where an attachment's file can be read from: the preview the editor made from the File it was
 * handed (fresh, no round trip), else the service's copy at the attachment's index in the list the
 * service has (`served`, the saved ticket's list), else nowhere yet (an unsaved draft, or an edit
 * the service hasn't got). The service's index is by the list it has, which may differ from what
 * the editor shows while an edit is on its way.
 */
export function attachmentSource(
  a: Pick<PromptAttachment, "path">,
  preview: string | undefined,
  served: readonly Pick<PromptAttachment, "path">[] | null | undefined,
  urlAt: ((index: number) => string) | null,
): { url: string; local: boolean } | null {
  if (preview) return { url: preview, local: true };
  if (!served || !urlAt) return null;
  const i = served.findIndex((s) => s.path === a.path);
  return i === -1 ? null : { url: urlAt(i), local: false };
}
