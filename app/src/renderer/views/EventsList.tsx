// A list of a ticket's events, newest first: a chief of staff's Inbox (CosInbox) and any ticket's Events
// tab (TicketDetail) are this same view. Each row says what kind of event it is, what happened, the
// verdict and, once handled, who handled it. Only a chief's Inbox can escalate an ignored row.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ticket, TicketEvent } from "@harness/shared";
import { canEscalate, eventRows, eventStateLabel, EVENT_SOURCE_LABEL, inboxState } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { Modal, relativeTime } from "../components/bits";
import { Transcript } from "./Transcript";
import { useAction, useStore } from "../state/store";

const PAGE = 50;

/** A ticket's Events tab: only shown once it has events (effectiveTab falls back to Spec until then). A chief's own ticket shows its Inbox rows. */
export function EventsTab({ ticket }: { ticket: Ticket }) {
  return (
    <div className="events-tab">
      <EventsList ticketId={ticket.id} chief={ticket.kind === "cos"} emptyText="No events yet." testId="ticket-events" />
    </div>
  );
}

/** The events aimed at `ticketId`, paged from the service and kept live by the store. `chief`: it is a chief's Inbox, which also lists the unassigned events and offers "Escalate anyway". */
export function EventsList({ ticketId, chief, emptyText, testId }: { ticketId: string; chief: boolean; emptyText: string; testId: string }) {
  const { state, client, dispatch, epoch } = useStore();
  const act = useAction();
  const rows = useMemo(() => eventRows(state.ticketEvents, { ticketId, chief }), [state.ticketEvents, ticketId, chief]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (before: string | null) => {
      setLoading(true);
      const page = await act(() => client.ticketEvents(ticketId, { before, limit: PAGE }));
      if (page) {
        dispatch({ type: "ticketEvents", events: page.items });
        setCursor((c) => (before === null && c !== undefined ? c : page.nextCursor));
      }
      setLoading(false);
    },
    [act, client, dispatch, ticketId],
  );
  useEffect(() => {
    setCursor(undefined);
    void load(null);
  }, [load, epoch]);

  return (
    <div className="cos-rows" data-testid={testId}>
      {rows.length === 0 && cursor !== undefined && (
        <div className="empty" data-testid="cos-inbox-empty">
          <Icon name="inbox" />
          {emptyText}
        </div>
      )}
      {rows.map((e) => (
        <EventRow key={e.id} event={e} chief={chief} />
      ))}
      {cursor && (
        <button className="btn btn-ghost btn-sm cos-older" data-testid="cos-more" disabled={loading} onClick={() => void load(cursor)}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

function EventRow({ event: e, chief }: { event: TicketEvent; chief: boolean }) {
  const { client, dispatch, navigate } = useStore();
  const act = useAction();
  const [looking, setLooking] = useState(false);
  const st = inboxState(e);
  const escalate = async () => {
    const next = await act(() => client.escalateCosEvent(e.id));
    if (next) dispatch({ type: "ticketEvents", events: [next] });
  };
  return (
    <div className="cos-event" data-testid="cos-event" data-state={st} data-event={e.id}>
      <div className="cos-event-main">
        <div className="cos-event-title">
          <span className="badge">{EVENT_SOURCE_LABEL[e.sourceKind]}</span>
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
          {eventStateLabel(st, chief)}
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
        {e.triageSessionId && (
          <button className="link-btn" data-testid="cos-triage-run" onClick={() => setLooking(true)}>
            What triage looked up
          </button>
        )}
        {chief && canEscalate(e) && (
          <button className="btn btn-sm" data-testid="cos-escalate" onClick={() => void escalate()}>
            Escalate anyway
          </button>
        )}
      </div>
      {looking && e.triageSessionId && (
        <Modal onClose={() => setLooking(false)} width={720}>
          <h3>Triage of “{e.title}”</h3>
          <div className="cos-triage-transcript" data-testid="cos-triage-transcript">
            <Transcript sessionId={e.triageSessionId} emptyHint="The triage run left no transcript." />
          </div>
        </Modal>
      )}
    </div>
  );
}
