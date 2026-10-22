// A chief of staff's memory: one markdown document, with its Triage guidance section, that the chief
// edits itself and the human can read and edit here. Saving is checked against the revision opened;
// a memory the chief changed meanwhile asks which copy to keep. No history is kept.

import { useEffect, useState } from "react";
import { memoryConflict, type Cos } from "@harness/shared";
import { Modal } from "../components/bits";
import { useAction, useStore } from "../state/store";

export function CosMemory({ chief, title, onClose }: { chief: Cos; title: string; onClose: () => void }) {
  const { client, toast } = useStore();
  const act = useAction();
  const [saved, setSaved] = useState<{ text: string; revision: string } | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  // The chief's text when it changed under the editor: shown beside the human's choices.
  const [conflict, setConflict] = useState<{ text: string; revision: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void act(() => client.getCosMemory(chief.key)).then((m) => {
      if (cancelled || !m) return;
      setSaved(m);
      setText(m.text);
    });
    return () => {
      cancelled = true;
    };
  }, [act, client, chief.key]);

  const dirty = saved !== null && text !== saved.text;

  const save = async () => {
    if (!saved || !dirty || saving) return;
    setSaving(true);
    try {
      const next = await client.putCosMemory(chief.key, { text, baseRevision: saved.revision });
      setSaved(next);
      setText(next.text);
      setConflict(null);
      toast("Memory saved", "info");
    } catch (e) {
      const c = memoryConflict(e);
      if (c) setConflict({ text: c.text, revision: c.currentRevision });
      else toast((e as Error).message, "error");
    }
    setSaving(false);
  };

  return (
    <Modal onClose={onClose} onSubmit={() => void save()} width={680}>
      <div className="modal-head">
        <strong>Memory · {title}</strong>
      </div>
      <div className="modal-body cos-memory">
        <p className="dim">
          What the chief of staff remembers. It edits this itself; its Triage guidance section tells the cheap model in front of it what not to wake it for. No history is kept.
        </p>
        {conflict && (
          <div className="cos-note" role="alert" data-testid="cos-memory-conflict">
            The chief of staff changed its memory while you were editing.
            <button
              className="btn btn-sm"
              onClick={() => {
                setSaved({ text: conflict.text, revision: conflict.revision });
                setText(conflict.text);
                setConflict(null);
              }}
            >
              Load its version
            </button>
            <button className="btn btn-sm" onClick={() => (setSaved({ text: conflict.text, revision: conflict.revision }), setConflict(null))}>
              Keep mine
            </button>
          </div>
        )}
        {saved === null ? (
          <div className="spinner" />
        ) : (
          <textarea className="input mono cos-memory-text" data-testid="cos-memory-text" aria-label="Memory" rows={18} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </div>
      <div className="modal-foot">
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
        <button className="btn btn-primary btn-sm" data-testid="cos-memory-save" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}
