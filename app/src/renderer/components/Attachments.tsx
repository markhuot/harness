// Screenshots and recordings attached to a ticket: a strip of thumbnails under the text,
// and a lightbox that shows one at up to the window's size. URLs come from the current client on
// every render (they carry the token), so a rotated token swaps them for working ones.

import { useEffect, useState } from "react";
import type { Attachment } from "@harness/shared";
import { stepAttachment, thumbnailBox } from "@harness/shared/state";
import { useStore } from "../state/store";
import { Icon } from "./Icon";
import { Modal } from "./bits";

const THUMB_HEIGHT = 96;

export function Attachments({ list }: { list: Attachment[] }) {
  const { client } = useStore();
  const [open, setOpen] = useState<number | null>(null);
  if (!list.length) return null;
  return (
    <>
      <div className="attachments">
        {list.map((a, i) => {
          const url = client.attachmentUrl(a.id);
          // Keyed by URL so a new token retries an attachment that failed to load.
          return <Thumbnail key={url} attachment={a} url={url} onOpen={() => setOpen(i)} />;
        })}
      </div>
      {open !== null && <Lightbox list={list} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

function Thumbnail({ attachment: a, url, onOpen }: { attachment: Attachment; url: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const box = thumbnailBox(a, THUMB_HEIGHT);
  return (
    <button
      className={`attachment-thumb ${failed ? "is-missing" : ""}`}
      style={{ width: box.width, height: box.height }}
      title={a.name}
      aria-label={`Open ${a.name}`}
      onClick={onOpen}
    >
      {failed ? (
        <Missing name={a.name} />
      ) : a.kind === "image" ? (
        <img src={url} alt={a.name} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <>
          {/* #t= makes WebKit paint a frame for the poster instead of a black box. */}
          <video src={`${url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} onError={() => setFailed(true)} />
          <span className="attachment-play">
            <Icon name="play" size={12} />
          </span>
        </>
      )}
    </button>
  );
}

export function Missing({ name }: { name: string }) {
  return (
    <span className="attachment-missing">
      <Icon name="image" size={16} />
      <span>{name}</span>
      <span className="muted">Couldn't load</span>
    </span>
  );
}

/** One attachment at a time over the app. ← and → (or the side buttons) step through the list (the images in a piece of markdown); Esc or the backdrop closes. */
export function Lightbox({ list, index, onIndex, onClose }: { list: Attachment[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { client } = useStore();
  // Attachments renders this only with a non-empty list.
  const a = list[Math.min(index, list.length - 1)]!;
  const url = client.attachmentUrl(a.id);
  const [failed, setFailed] = useState<string | null>(null);
  const many = list.length > 1;
  const step = (delta: number) => onIndex(stepAttachment(index, delta, list.length));

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // A focused video keeps its own arrows (seeking).
      if (!many || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLVideoElement) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        onIndex(stepAttachment(index, e.key === "ArrowLeft" ? -1 : 1, list.length));
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [many, index, list.length, onIndex]);

  return (
    <Modal onClose={onClose} className="lightbox">
      <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {failed === url ? (
          <Missing name={a.name} />
        ) : a.kind === "image" ? (
          <img key={url} src={url} alt={a.name} onError={() => setFailed(url)} />
        ) : (
          <video key={url} src={url} controls autoPlay playsInline onError={() => setFailed(url)} />
        )}
        {many && (
          <>
            <button className="lightbox-nav prev" aria-label="Previous attachment" title="Previous (←)" onClick={() => step(-1)}>
              <Icon name="chevronLeft" size={20} />
            </button>
            <button className="lightbox-nav next" aria-label="Next attachment" title="Next (→)" onClick={() => step(1)}>
              <Icon name="chevronRight" size={20} />
            </button>
          </>
        )}
      </div>
      <div className="lightbox-bar">
        <span className="lightbox-name" title={a.name}>
          {a.name}
        </span>
        {many && (
          <span className="muted mono">
            {index + 1} / {list.length}
          </span>
        )}
        <div className="grow" />
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
    </Modal>
  );
}
