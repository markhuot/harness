// A chief of staff's Inbox: the events list (EventsList) of the events it owns (plus any nobody owns
// yet), so a stuck or switched-off chief never hides them. The + asks the chief, in chat, to listen
// for something; the chief creates the listener with its own tools.

import { useState } from "react";
import type { Cos } from "@harness/shared";
import { Icon } from "../components/Icon";
import { Modal } from "../components/bits";
import { EventsList } from "./EventsList";
import { useAction, useStore } from "../state/store";

export function CosInbox({ chief, onChat }: { chief: Cos; onChat: () => void }) {
  const [asking, setAsking] = useState(false);

  return (
    <div className="cos-inbox" data-testid="cos-inbox">
      <div className="cos-inbox-bar">
        <span className="dim">{chief.enabled ? "What this chief of staff has seen" : "Switched off: events wait here until it is on"}</span>
        <div className="grow" />
        <button className="btn btn-sm" data-testid="cos-listen" onClick={() => setAsking(true)} title="Ask the chief of staff to listen for something" aria-label="Listen for something">
          <Icon name="plus" size={12} /> Listen
        </button>
      </div>
      <EventsList ticketId={chief.ticketId} chief emptyText="Nothing yet. Ticket moves, watcher items and schedules show up here." testId="cos-rows" />
      {asking && <ListenPrompt chief={chief} onClose={() => setAsking(false)} onSent={onChat} />}
    </div>
  );
}

/** The + prompt: what to listen for, sent to the chief as a message (which switches to the chat). */
function ListenPrompt({ chief, onClose, onSent }: { chief: Cos; onClose: () => void; onSent: () => void }) {
  const { client } = useStore();
  const act = useAction();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await act(() => client.sendCosMessage(chief.ticketId, text.trim()));
    setSending(false);
    if (ok) {
      onClose();
      onSent();
    }
  };
  return (
    <Modal onClose={onClose} onSubmit={() => void send()} width={460}>
      <div className="modal-head">Listen for something</div>
      <div className="modal-body cos-listen">
        <p className="dim">Tell the chief of staff what to listen for. It sets up the listener itself and asks if it needs more.</p>
        <textarea
          className="input"
          autoFocus
          rows={4}
          data-testid="cos-listen-input"
          aria-label="What to listen for"
          placeholder="Listen to GitHub for PR feedback on …"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {!chief.enabled && <p className="dim">This chief of staff is off: turn it on to have it act on this.</p>}
      </div>
      <div className="modal-foot">
        <button className="btn btn-sm" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" data-testid="cos-listen-send" disabled={!text.trim() || sending || !chief.enabled} onClick={() => void send()}>
          Ask
        </button>
      </div>
    </Modal>
  );
}
