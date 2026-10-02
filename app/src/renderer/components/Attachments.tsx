// Screenshots and recordings attached to a ticket, as Markdown shows them inline (attachment:<id>
// images): a lightbox that shows one at up to the window's size, and the card for one that couldn't
// load. URLs come from the current client on every render (they carry the token), so a rotated
// token swaps them for working ones.

import { useEffect, useState } from "react";
import type { Attachment } from "@harness/shared";
import { stepAttachment } from "@harness/shared/state";
import { useStore } from "../state/store";
import { Icon } from "./Icon";
import { Modal } from "./bits";

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
  // Markdown renders this only with a non-empty list.
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
