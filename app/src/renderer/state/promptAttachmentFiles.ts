// Attachments on the Mac (DESIGN.md "Attachments"): the pure decisions behind the draft editor's
// and the composer's paperclip, drops and pastes, and the list that shows them. A file that's on
// disk is registered with the service by its path (referenced in place, never copied) when the
// service is on this Mac; anything else (pasted image data, an image dragged out of a browser, any
// file for a service elsewhere) is uploaded first. Either way the list holds the Attachment the
// service answered with, so every file is read back by its id. No React or DOM APIs beyond the
// File-like shape.

import type { Attachment, AttachmentKind } from "@harness/shared";
import { fileBaseName, pastedImageName, type Media } from "@harness/shared/state";

/** What the editor knows about a File it was handed: its name, MIME type and (from the preload) path on disk. */
export interface FileLike {
  name: string;
  type: string;
}

/** A batch of files, split into the ones registered in place and the ones that have to be uploaded. */
export interface FilePlan<F> {
  /** Files on the service's machine: registered by path (POST /attachments) */
  registers: { path: string; name: string; file: F }[];
  uploads: { file: F; name: string; mimeType: string }[];
  /** Pathless files that aren't worth uploading (a paste's non-image data) */
  ignored: number;
}

/**
 * Sort `files` by where they come from. `pathOf` is the preload's webUtils lookup (null for data
 * with no file behind it). With the service on this Mac (`local`), a file with a path is registered
 * by it. With a service on another machine that path means nothing there, so the file's bytes are
 * uploaded under its own name instead. A pathless one is uploaded: always for a drop or a pick
 * (`uploadAny`), and only when it's an image for a paste, so a paste of rich text that happens to
 * carry other data still pastes as text.
 */
export function planFiles<F extends FileLike>(files: readonly F[], pathOf: (f: F) => string | null, opts: { uploadAny: boolean; local: boolean }): FilePlan<F> {
  const plan: FilePlan<F> = { registers: [], uploads: [], ignored: 0 };
  for (const file of files) {
    const path = pathOf(file);
    if (path && opts.local) {
      plan.registers.push({ path, name: file.name || fileBaseName(path), file });
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
export function limitMessage(skipped: number, max: number, what = "a session"): string | null {
  if (skipped <= 0) return null;
  return `${skipped === 1 ? "1 file wasn't" : `${skipped} files weren't`} attached: ${what} takes at most ${max}.`;
}

/** The shape of navigator.clipboard.read()'s items that clipboardImageFiles reads. */
export interface ClipboardItemLike {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
}

/**
 * The images on the clipboard (a screenshot, an image copied in a browser) as Files, one per item
 * that carries one, for the composer's "Paste image". Named "image.<ext>" like a paste event's, so
 * planFiles names them the way it names a pasted image.
 */
export async function clipboardImageFiles(items: readonly ClipboardItemLike[]): Promise<File[]> {
  const out: File[] = [];
  for (const item of items) {
    const type = item.types.find((t) => t.toLowerCase().startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    const ext = type.slice("image/".length).split(/[+;]/)[0] || "png";
    out.push(new File([blob], `image.${ext}`, { type }));
  }
  return out;
}

/** What a ticket's message composer has: what's typed, what's attached, and what's on its way. */
export interface ComposerDraft {
  text: string;
  attachments: number;
  /** Uploads on their way (they'd be left out of a message sent now) */
  pending: number;
  sending: boolean;
  /** A tool approval waits: a message answers it (as a deny), and can't carry attachments then. */
  approvalPending: boolean;
}

/**
 * Whether Send is enabled: something to send (text, or at least one attachment) and nothing in the
 * way (an upload still going, a send in flight, or attachments while an approval waits).
 */
export function composerCanSend(d: ComposerDraft): boolean {
  if (d.sending || d.pending > 0) return false;
  if (d.attachments > 0 && d.approvalPending) return false;
  return !!d.text.trim() || d.attachments > 0;
}

/** The label and tooltip of an attachment whose file is gone. */
export const missingLabel = (a: Pick<Attachment, "path">) => (a.path ? `Missing — was at ${a.path}` : "Missing");

/**
 * The attachment a spec's `![alt](attachment:<id>)` shows: the ticket's own record of it
 * (TicketDetail.attachments) when the client has one, else one made from the markdown (an older
 * service, or an image added since the detail was fetched). Either has the id, which is all that
 * reading the file or attaching it to a message needs.
 */
export function mediaAttachment(media: Pick<Media, "id" | "alt">, known: readonly Attachment[] | null | undefined, kind: AttachmentKind): Attachment {
  const found = known?.find((a) => a.id === media.id);
  if (found) return found;
  return { id: media.id, path: "", name: media.alt || media.id, source: "spec", kind, mimeType: "" };
}

/**
 * The notes `list` (a composer's, a draft's) already has on `a`'s file, so annotating it again
 * from anywhere (the spec, the Transcript) edits those: the same attachment by id, or by path for
 * one the service hasn't registered.
 */
export function waitingAnnotation(list: readonly Attachment[], a: Pick<Attachment, "id" | "path">): Attachment["annotation"] {
  return list.find((x) => (x.id && a.id ? x.id === a.id : !!a.path && x.path === a.path))?.annotation;
}
