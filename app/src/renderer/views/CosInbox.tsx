// A chief of staff's Inbox: a plain list of the events it owns (plus any nobody owns yet), so a
// stuck or switched-off chief never hides them. Each row says what happened, the verdict and, once
// handled, who handled it. Ignored rows can be escalated by hand. The + asks the chief, in chat,
// to listen for something; the chief creates the listener with its own tools.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Cos, CosEvent } from "@harness/shared";
import { canEscalate, inboxState, mergeEvents } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { Modal, relativeTime } from "../components/bits";
import { useAction, useStore } from "../state/store";

const PAGE = 50;

/** The rows a chief's Inbox shows: its own events and the unassigned ones, newest first. Rows its own rules dropped (filtered) stay out, except a reminder: it went to you, so it shows. */
export function inboxRows(events: Record<string, CosEvent>, cosId: string): CosEvent[] {
  return mergeEvents(
    [],
    Object.values(events).filter((e) => (e.cosId === cosId || e.cosId === null) && (e.verdict !== "filtered" || e.sourceKind === "schedule")),
  );
}

export function CosInbox({ chief, onChat }: { chief: Cos; onChat: () => void }) {
  const { state, client, dispatch, epoch } = useStore();
  const act = useAction();
  const id = chief.ticketId;
  const rows = useMemo(() => inboxRows(state.cosEvents, id), [state.cosEvents, id]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [asking, setAsking] = useState(false);

  const load = useCallback(
    async (before: string | null) => {
      setLoading(true);
      const page = await act(() => client.cosEvents(id, { before, limit: PAGE }));
      if (page) {
        dispatch({ type: "cosEvents", events: page.items });
        setCursor((c) => (before === null && c !== undefined ? c : page.nextCursor));
      }
      setLoading(false);
    },
    [act, client, dispatch, id],
  );
  useEffect(() => {
    void load(null);
  }, [load, epoch]);

  return (
    <div className="cos-inbox" data-testid="cos-inbox">
      <div className="cos-inbox-bar">
        <span className="dim">{chief.enabled ? "What this chief of staff has seen" : "Switched off: events wait here until it is on"}</span>
        <div className="grow" />
        <button className="btn btn-sm" data-testid="cos-listen" onClick={() => setAsking(true)} title="Ask the chief of staff to listen for something" aria-label="Listen for something">
          <Icon name="plus" size={12} /> Listen
        </button>
      </div>
      <div className="cos-rows">
        {rows.length === 0 && cursor !== undefined && (
          <div className="empty" data-testid="cos-inbox-empty">
            <Icon name="inbox" />
            Nothing yet. Ticket moves, watcher items and schedules show up here.
          </div>
        )}
        {rows.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
        {cursor && (
          <button className="btn btn-ghost btn-sm cos-older" data-testid="cos-more" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
      {asking && <ListenPrompt chief={chief} onClose={() => setAsking(false)} onSent={onChat} />}
    </div>
  );
}

const STATE_LABEL = { waiting: "Waiting for a verdict", ignored: "Ignored", escalated: "Escalated", handling: "Handling", acted: "Acted", no_action: "No action needed", needs_user: "Needs you", reviewed: "Reviewed, no outcome recorded", filtered: "Filtered" } as const;
const SOURCE_LABEL = { activity: "Ticket", watcher: "Watcher", schedule: "Schedule" } as const;

function EventRow({ event: e }: { event: CosEvent }) {
  const { client, dispatch, navigate } = useStore();
  const act = useAction();
  const st = inboxState(e);
  const escalate = async () => {
    const next = await act(() => client.escalateCosEvent(e.id));
    if (next) dispatch({ type: "cosEvents", events: [next] });
  };
  return (
    <div className="cos-event" data-testid="cos-event" data-state={st} data-event={e.id}>
      <div className="cos-event-main">
        <div className="cos-event-title">
          <span className="badge">{SOURCE_LABEL[e.sourceKind]}</span>
          {e.ticketKey ? (
            <button className="link-btn mono" onClick={() => navigate({ view: "board", projectId: null, ticketKey: e.ticketKey, tab: "spec" })}>
              {e.ticketKey}
            </button>
          ) : (
            e.projectKey && <span className="mono dim">{e.projectKey}</span>
          )}
          <span className="truncate">{e.title}</span>
        </div>
        {e.summary && <div className="cos-event-sub dim">{e.summary}</div>}
        <div className="cos-event-meta dim">
          {e.actor} · {relativeTime(e.createdAt)}
        </div>
      </div>
      <div className="cos-verdict">
        <span className={`cos-pill cos-pill-${st}`} data-testid="cos-verdict">
          {STATE_LABEL[st]}
        </span>
        {(st === "ignored" || st === "filtered") && e.reason && (
          <span className="cos-reason dim" data-testid="cos-reason">
            {e.reason}
          </span>
        )}
        {st === "escalated" && e.reason && <span className="cos-reason dim">{e.reason}</span>}
        {e.outcome && (st === "acted" || st === "no_action" || st === "needs_user") && (
          <span className="cos-reason dim" data-testid="cos-outcome">
            {e.outcome.text}
          </span>
        )}
        {canEscalate(e) && (
          <button className="btn btn-sm" data-testid="cos-escalate" onClick={() => void escalate()}>
            Escalate anyway
          </button>
        )}
      </div>
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
