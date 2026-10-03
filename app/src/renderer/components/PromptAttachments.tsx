// The files attached to a New session's prompt (Ticket.promptAttachments, DESIGN.md "Prompt
// attachments"): a strip of image thumbnails and file chips in the draft editor (each with ×), and a
// read-only vertical list at the bottom of a ticket's Spec tab. A file can go missing after it was attached (moved or
// deleted on disk): an image that won't load, or a file the service answers 404 for, shows as a
// dashed chip saying where it was. Clicking an image opens the lightbox, clicking a file reveals it
// in Finder.

import { useEffect, useState, type ReactNode } from "react";
import type { Attachment, PromptAttachment } from "@harness/shared";
import { promptAttachmentIsImage } from "@harness/shared/state";
import { useStore } from "../state/store";
import { attachmentSource, isFileDrag, missingLabel } from "../state/promptAttachmentFiles";
import { Icon } from "./Icon";
import { Lightbox } from "./Attachments";

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

/**
 * Object URLs of files the editor was handed (picked, dropped, pasted), by path: the thumbnail
 * shows at once, before the draft is saved or the service has the file. Kept for the page's life
 * (they're small, and the same draft can reopen in another pane); removing an attachment frees its own.
 */
const previews = new Map<string, string>();

/** Remember `file` as the preview of the attachment at `path` (images only). */
export function rememberPreview(path: string, file: Blob) {
  if (previews.has(path) || !file.type.toLowerCase().startsWith("image/")) return;
  previews.set(path, URL.createObjectURL(file));
}

export function forgetPreview(path: string) {
  const url = previews.get(path);
  if (!url) return;
  URL.revokeObjectURL(url);
  previews.delete(path);
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

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

export interface PendingUpload {
  id: string;
  name: string;
}

export function PromptAttachmentStrip({
  items,
  ticketKey,
  served,
  onRemove,
  pending = [],
  children,
}: {
  items: readonly PromptAttachment[];
  /** The ticket the service has them on: its files are read from there. Null before the first save. */
  ticketKey: string | null;
  /** The list as the service has it (indexes in the service's URLs are by this list) */
  served: readonly PromptAttachment[] | null | undefined;
  /** Editable: each item gets × */
  onRemove?: (index: number) => void;
  /** Uploads on their way (pastes), shown as spinner chips at the end */
  pending?: readonly PendingUpload[];
  /** Extra controls at the end of the row (the editor's Attach files button) */
  children?: ReactNode;
}) {
  const { client } = useStore();
  const [open, setOpen] = useState<number | null>(null);
  const urlAt = ticketKey ? (i: number) => client.promptAttachmentUrl(ticketKey, i) : null;
  const sourceOf = (a: PromptAttachment) => attachmentSource(a, previews.get(a.path), served, urlAt);

  // The lightbox steps through the images that have something to show.
  const images = items.filter((a) => promptAttachmentIsImage(a) && sourceOf(a));
  const lightboxList: Attachment[] = images.map((a) => ({ id: a.path, kind: "image", mimeType: "", name: a.name, size: 0 }));

  if (!items.length && !pending.length && !children) return null;
  return (
    <div className="prompt-attachments" data-testid="prompt-attachments" role="list" aria-label="Attachments">
      {items.map((a, i) => (
        <AttachmentItem
          key={a.path}
          a={a}
          source={sourceOf(a)}
          onOpen={promptAttachmentIsImage(a) ? () => setOpen(images.indexOf(a)) : undefined}
          onRemove={onRemove && (() => onRemove(i))}
        />
      ))}
      {pending.map((p) => (
        <div key={p.id} className="prompt-attachment pending" role="listitem" data-testid="prompt-attachment-pending" aria-label={`Uploading ${p.name}`}>
          <span className="spinner" />
          <span className="prompt-attachment-name truncate">{p.name}</span>
        </div>
      ))}
      {children}
      {open !== null && open >= 0 && lightboxList.length > 0 && (
        <Lightbox
          list={lightboxList}
          index={Math.min(open, lightboxList.length - 1)}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          urlOf={(_x, idx) => sourceOf(images[idx]!)!.url}
        />
      )}
    </div>
  );
}

type Source = { url: string; local: boolean } | null;

/**
 * Whether the attachment's file has gone missing: an image whose URL failed to load (call
 * `failedAt` from its onError), or a file the service answers 404 for (probed with HEAD, since a
 * file shows nothing to load).
 */
function useMissing(a: PromptAttachment, source: Source): { missing: boolean; failedAt: (url: string) => void } {
  const image = promptAttachmentIsImage(a);
  const url = source?.url ?? null;
  // Which URL failed (a new one, after a token rotation or a save, gets another try).
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
// The list (a ticket's Spec tab)
// ---------------------------------------------------------------------------

/**
 * The ticket's attachments, read-only, at the bottom of its Spec tab: one row each, a same-size
 * square (the image's thumbnail, or a file icon) then the name, so the names line up. A missing
 * file says where it was.
 */
export function PromptAttachmentList({ ticketKey, items }: { ticketKey: string; items: readonly PromptAttachment[] }) {
  const { client } = useStore();
  const [open, setOpen] = useState<number | null>(null);
  const sourceOf = (a: PromptAttachment): Source => attachmentSource(a, previews.get(a.path), items, (i) => client.promptAttachmentUrl(ticketKey, i));
  const images = items.map((a, i) => ({ a, i })).filter(({ a }) => promptAttachmentIsImage(a));
  const lightboxList: Attachment[] = images.map(({ a }) => ({ id: a.path, kind: "image", mimeType: "", name: a.name, size: 0 }));
  if (!items.length) return null;
  return (
    <ul className="prompt-attachment-list" data-testid="prompt-attachments" aria-label="Attachments">
      {items.map((a, i) => (
        <AttachmentRow key={a.path} a={a} source={sourceOf(a)} onOpen={promptAttachmentIsImage(a) ? () => setOpen(images.findIndex((x) => x.i === i)) : undefined} />
      ))}
      {open !== null && open >= 0 && lightboxList.length > 0 && (
        <Lightbox
          list={lightboxList}
          index={Math.min(open, lightboxList.length - 1)}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          urlOf={(_x, idx) => sourceOf(images[idx]!.a)!.url}
        />
      )}
    </ul>
  );
}

function AttachmentRow({ a, source, onOpen }: { a: PromptAttachment; source: Source; onOpen?: () => void }) {
  const image = promptAttachmentIsImage(a);
  const url = source?.url ?? null;
  const { missing, failedAt } = useMissing(a, source);
  const label = missing ? missingLabel(a) : null;
  const icon = <Icon name={image ? "image" : "fileText"} size={16} />;
  return (
    <li className={`prompt-attachment-row${missing ? " missing" : ""}`} data-testid="prompt-attachment" data-path={a.path} data-kind={image ? "image" : "file"} data-missing={missing ? "true" : undefined}>
      <button
        type="button"
        className="prompt-attachment-row-open"
        disabled={missing}
        title={label ?? a.path}
        aria-label={label ? `${a.name}: ${label}` : image ? `Open ${a.name}` : `${a.name}, reveal in Finder`}
        onClick={image && url ? onOpen : () => void window.harness?.revealInFinder(a.path)}
      >
        <span className="prompt-attachment-row-media">{image && url && !missing ? <img src={url} alt="" onError={() => failedAt(url)} draggable={false} /> : icon}</span>
        <span className="prompt-attachment-row-text">
          <span className="prompt-attachment-name truncate">{a.name}</span>
          {label && <span className="prompt-attachment-note truncate">{label}</span>}
        </span>
      </button>
    </li>
  );
}

function AttachmentItem({ a, source, onOpen, onRemove }: { a: PromptAttachment; source: Source; onOpen?: () => void; onRemove?: () => void }) {
  const image = promptAttachmentIsImage(a);
  const url = source?.url ?? null;
  const { missing, failedAt: setFailed } = useMissing(a, source);
  const remove = onRemove && (
    <button
      type="button"
      className="prompt-attachment-remove"
      data-testid="prompt-attachment-remove"
      title={`Remove ${a.name}`}
      aria-label={`Remove ${a.name}`}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
    >
      <Icon name="x" size={10} strokeWidth={2.5} />
    </button>
  );

  if (missing) {
    const label = missingLabel(a);
    return (
      <div className="prompt-attachment missing" role="listitem" data-testid="prompt-attachment" data-missing="true" data-path={a.path} title={label} aria-label={`${a.name}: ${label}`}>
        <Icon name={image ? "image" : "fileText"} size={13} />
        <span className="prompt-attachment-name truncate">{a.name}</span>
        <span className="prompt-attachment-note truncate">{label}</span>
        {remove}
      </div>
    );
  }

  if (image && url) {
    return (
      <div className="prompt-attachment thumb" role="listitem" data-testid="prompt-attachment" data-path={a.path} data-kind="image">
        <button type="button" className="prompt-attachment-open" title={`${a.name}\n${a.path}`} aria-label={`Open ${a.name}`} onClick={onOpen}>
          <img src={url} alt={a.name} onError={() => setFailed(url)} draggable={false} />
        </button>
        {remove}
      </div>
    );
  }

  return (
    <div className="prompt-attachment chip-file" role="listitem" data-testid="prompt-attachment" data-path={a.path} data-kind={image ? "image" : "file"}>
      <button
        type="button"
        className="prompt-attachment-open"
        title={a.path}
        aria-label={`${a.name}, reveal in Finder`}
        onClick={() => void window.harness?.revealInFinder(a.path)}
      >
        <Icon name={image ? "image" : "fileText"} size={13} />
        <span className="prompt-attachment-name truncate">{a.name}</span>
      </button>
      {remove}
    </div>
  );
}
