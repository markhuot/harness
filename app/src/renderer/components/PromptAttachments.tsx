// Attachments as one vertical list (DESIGN.md "Attachments"): a New session's files
// (Ticket.promptAttachments) and the files of a message being written, editable in the draft editor
// and the ticket's composer (each row with ×, files on their way to the service as spinner rows);
// read-only at the bottom of a ticket's Spec tab and under a message in the Transcript. Every row is
// an Attachment the service registered, read back by its id (GET /attachments/:id), wherever it came
// from (a spec image, an upload, a file on disk). Every row starts with the same square (an image's
// thumbnail, or a file icon), so the names line up. A file can go missing after it was attached
// (moved or deleted on disk): an image that won't load, or a file the service answers 404 for,
// shows dimmed with where it was. Clicking an image opens the lightbox, clicking a file reveals it
// in Finder. An annotated image (DESIGN.md "Annotations") shows its marks over the thumbnail (and
// in the lightbox) and lists its numbered notes under its row, behind "N notes".

import { useEffect, useState, type ReactNode } from "react";
import type { Attachment, AttachmentAnnotation } from "@harness/shared";
import { annotationNotesLabel, attachmentIsImage } from "@harness/shared/state";
import { useStore } from "../state/store";
import { isFileDrag, missingLabel } from "../state/promptAttachmentFiles";
import { Icon } from "./Icon";
import { Lightbox } from "./Attachments";
import type { AnnotateOffer } from "./Annotator";
import { ThumbnailAnnotation } from "./AnnotationOverlay";

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

/**
 * Object URLs of files the editor was handed (picked, dropped, pasted, annotated), by attachment
 * id: the thumbnail shows from the bytes in hand, without a round trip. Kept for the page's life
 * (they're small, and the same draft can reopen in another pane); removing an attachment frees its own.
 */
const previews = new Map<string, string>();
/** The file behind each preview URL: a page loaded from file:// can't fetch() its own blob: URLs, so the annotator reads the bytes from here. */
const previewFiles = new Map<string, Blob>();

/** Remember `file` as the preview of the attachment `id` (images only). */
export function rememberPreview(id: string, file: Blob) {
  if (!id || previews.has(id) || !file.type.toLowerCase().startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  previews.set(id, url);
  previewFiles.set(url, file);
}

export function forgetPreview(id: string) {
  const url = previews.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  previews.delete(id);
  previewFiles.delete(url);
}

/** The bytes of a preview URL this page made, if `url` is one. */
export function previewFile(url: string): Blob | undefined {
  return previewFiles.get(url);
}

/**
 * A file dropped anywhere the page doesn't take it would make the window navigate to it (Chromium's
 * default, and the main process lets file:// through). Swallow those; the draft pane's own handlers
 * run first and mark the drops they take.
 */
export function installFileDropGuard() {
  window.addEventListener("dragover", (e: DragEvent) => {
    if (e.defaultPrevented || !isFileDrag(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "none";
  });
  window.addEventListener("drop", (e: DragEvent) => {
    if (isFileDrag(e.dataTransfer?.types)) e.preventDefault();
  });
}

/** Lucide's paperclip, for the editor's Attach files button (not in the shared icon set). */
export function PaperclipIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export interface PendingUpload {
  id: string;
  name: string;
}

type Source = { url: string; local: boolean } | null;

/**
 * Whether the attachment's file has gone missing: an image whose URL failed to load (call
 * `failedAt` from its onError), or a file the service answers 404 for (probed with HEAD, since a
 * file shows nothing to load).
 */
function useMissing(a: Attachment, source: Source): { missing: boolean; failedAt: (url: string) => void } {
  const image = attachmentIsImage(a);
  const url = source?.url ?? null;
  // Which URL failed (a new one, after a token rotation, gets another try).
  const [failed, setFailed] = useState<string | null>(null);
  const [probed, setProbed] = useState<{ url: string; missing: boolean } | null>(null);

  useEffect(() => {
    if (image || !url || source?.local) return;
    let live = true;
    fetch(url, { method: "HEAD" }).then(
      (res) => live && setProbed({ url, missing: res.status === 404 }),
      () => {},
    );
    return () => void (live = false);
  }, [image, url, source?.local]);

  return { missing: (!!url && failed === url) || (!!url && probed?.url === url && probed.missing), failedAt: setFailed };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function PromptAttachmentList({
  items,
  onRemove,
  pending = [],
  annotate,
  children,
}: {
  items: readonly Attachment[];
  /** Editable: each row gets × */
  onRemove?: (index: number) => void;
  /** Files on their way to the service (pastes, drops), shown as spinner rows at the end */
  pending?: readonly PendingUpload[];
  /** How the lightbox offers Annotate for the image `a` (one of `items`), or null where it doesn't */
  annotate?: (a: Attachment) => AnnotateOffer | null;
  /** Controls under the rows (the editor's Attach files button) */
  children?: ReactNode;
}) {
  const { client } = useStore();
  const [open, setOpen] = useState<number | null>(null);
  const sourceOf = (a: Attachment): Source => {
    const preview = previews.get(a.id);
    if (preview) return { url: preview, local: true };
    return a.id ? { url: client.attachmentUrl(a.id), local: false } : null;
  };

  // The lightbox steps through the images that have something to show.
  const images = items.filter((a) => attachmentIsImage(a) && sourceOf(a));

  if (!items.length && !pending.length && !children) return null;
  return (
    <div className="prompt-attachment-list-wrap">
      {(items.length > 0 || pending.length > 0) && (
        <ul className="prompt-attachment-list" data-testid="prompt-attachments" aria-label="Attachments">
          {items.map((a, i) => (
            <AttachmentRow
              key={a.id || a.path}
              a={a}
              source={sourceOf(a)}
              onOpen={attachmentIsImage(a) ? () => setOpen(images.indexOf(a)) : undefined}
              onRemove={onRemove && (() => onRemove(i))}
            />
          ))}
          {pending.map((p) => (
            <li key={p.id} className="prompt-attachment-row pending" data-testid="prompt-attachment-pending" aria-label={`Uploading ${p.name}`}>
              <span className="prompt-attachment-row-main">
                <span className="prompt-attachment-row-media">
                  <span className="spinner" />
                </span>
                <span className="prompt-attachment-row-text">
                  <span className="prompt-attachment-name truncate">{p.name}</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {children}
      {open !== null && open >= 0 && images.length > 0 && (
        <Lightbox
          list={images}
          index={Math.min(open, images.length - 1)}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          urlOf={(a) => sourceOf(a)!.url}
          annotate={annotate}
        />
      )}
    </div>
  );
}

function AttachmentRow({ a, source, onOpen, onRemove }: { a: Attachment; source: Source; onOpen?: () => void; onRemove?: () => void }) {
  const image = attachmentIsImage(a);
  const notes = a.annotation && a.annotation.marks.length > 0 ? a.annotation : null;
  const url = source?.url ?? null;
  const { missing, failedAt } = useMissing(a, source);
  const label = missing ? missingLabel(a) : null;
  const icon = <Icon name={image ? "image" : "fileText"} size={16} />;
  return (
    <li className={`prompt-attachment-row${missing ? " missing" : ""}${notes ? " annotated" : ""}`} data-testid="prompt-attachment" data-id={a.id} data-path={a.path} data-source={a.source} data-kind={image ? "image" : "file"} data-missing={missing ? "true" : undefined}>
      <button
        type="button"
        className="prompt-attachment-row-main prompt-attachment-row-open"
        disabled={missing}
        title={label ?? (a.path || a.name)}
        aria-label={label ? `${a.name}: ${label}` : image ? `Open ${a.name}` : `${a.name}, reveal in Finder`}
        onClick={image && url ? onOpen : a.path ? () => void window.harness?.revealInFinder(a.path) : undefined}
      >
        <span className="prompt-attachment-row-media">
          {image && url && !missing ? (
            <>
              <img src={url} alt="" onError={() => failedAt(url)} draggable={false} />
              {notes && <ThumbnailAnnotation annotation={notes} />}
            </>
          ) : (
            icon
          )}
        </span>
        <span className="prompt-attachment-row-text">
          <span className="prompt-attachment-name truncate">{a.name}</span>
          {label && <span className="prompt-attachment-note truncate">{label}</span>}
        </span>
      </button>
      {onRemove && (
        <button type="button" className="prompt-attachment-remove" data-testid="prompt-attachment-remove" title={`Remove ${a.name}`} aria-label={`Remove ${a.name}`} onClick={onRemove}>
          <Icon name="x" size={12} strokeWidth={2.25} />
        </button>
      )}
      {notes && <AnnotationNotes annotation={notes} />}
    </li>
  );
}

/** "N notes" under an annotated image; opens to its numbered list (what goes, or went, to the agent). */
function AnnotationNotes({ annotation }: { annotation: AttachmentAnnotation }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="t-annotations" data-testid="annotation-notes">
      <button type="button" className="t-annotations-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        {annotationNotesLabel(annotation.marks.length)}
      </button>
      {open && (
        <ol className="t-annotations-list selectable" data-testid="annotation-notes-list">
          {annotation.marks.map((m) => (
            <li key={m.n}>
              <span className="t-annotations-n">{m.n}</span>
              {m.message ? <span>{m.message}</span> : <span className="empty-message">No message</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
