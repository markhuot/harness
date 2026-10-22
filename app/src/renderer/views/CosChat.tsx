// A chief of staff's chat: one continuous conversation, newest at the bottom. Older messages page in
// as the reader scrolls up (the scroller keeps what was on screen where it was), live entries
// arrive on the socket, and the composer posts a message that skips triage.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Cos, CosChatEntry } from "@harness/shared";
import { anchoredScrollTop, nearTop, ticketByKey } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { MOD, relativeTime, STATUS_LABEL, StatusDot } from "../components/bits";
import { useStickToBottom } from "../components/stickToBottom";
import { useAction, useStore } from "../state/store";

const PAGE = 30;
const NONE: CosChatEntry[] = [];

const statusLabel = (s: string) => (STATUS_LABEL as Record<string, string>)[s] ?? s;
const isStatus = (s: string): s is keyof typeof STATUS_LABEL => s in STATUS_LABEL;

export function CosChat({ chief }: { chief: Cos }) {
  const { state, client, dispatch, epoch } = useStore();
  const act = useAction();
  const id = chief.ticketId;
  const entries = state.cosChat[id] ?? NONE;
  // The cursor of the next older page: undefined before the first page, null once there is no more.
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const scroller = useStickToBottom<HTMLDivElement>();
  const busy = useRef(false);
  const anchor = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      const el = scroller.current;
      if (before && el) anchor.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
      const page = await act(() => client.cosTranscript(id, { before, limit: PAGE }));
      if (page) {
        dispatch({ type: "cosChat", cosId: id, entries: page.entries });
        // A refetch of the newest page (a reconnect, a sent message) keeps the cursor of what's paged in.
        setCursor((c) => (before === null && c !== undefined ? c : page.nextCursor));
      } else anchor.current = null;
      busy.current = false;
      setLoading(false);
    },
    [act, client, dispatch, id, scroller],
  );

  useEffect(() => {
    void load(null);
  }, [load, epoch]);

  // Older entries went in above: put the reader back where they were.
  useLayoutEffect(() => {
    const el = scroller.current;
    const before = anchor.current;
    if (!el || !before) return;
    anchor.current = null;
    el.scrollTop = anchoredScrollTop(before, el.scrollHeight);
  }, [entries, scroller]);

  return (
    <div className="cos-chat" data-testid="cos-chat">
      <div
        className="cos-scroll"
        ref={scroller}
        data-testid="cos-scroll"
        onScroll={(e) => {
          if (cursor && !busy.current && nearTop(e.currentTarget.scrollTop)) void load(cursor);
        }}
      >
        {cursor && (
          <button className="btn btn-ghost btn-sm cos-older" data-testid="cos-older" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? "Loading…" : "Load earlier messages"}
          </button>
        )}
        {entries.length === 0 && cursor !== undefined && (
          <div className="empty" data-testid="cos-chat-empty">
            <Icon name="message" />
            No messages yet. Ask the chief of staff anything about your boards.
          </div>
        )}
        {entries.map((e) => (
          <ChatEntry key={e.id} entry={e} />
        ))}
      </div>
      <Composer chief={chief} onSent={() => void load(null)} />
    </div>
  );
}

const ChatEntry = memo(function ChatEntry({ entry }: { entry: CosChatEntry }) {
  switch (entry.kind) {
    case "message":
      return entry.role === "user" ? (
        <div className="t-user" data-testid="cos-msg-user">
          <div className="t-who">
            <Icon name="user" size={12} /> You <span className="t-time">{relativeTime(entry.createdAt)}</span>
          </div>
          <div className="t-bubble">
            <Markdown text={entry.text} />
          </div>
        </div>
      ) : (
        <div className="t-assistant" data-testid="cos-msg-assistant">
          <div className="t-who">
            <Icon name="bot" size={12} /> Chief of staff <span className="t-time">{relativeTime(entry.createdAt)}</span>
          </div>
          <Markdown text={entry.text} />
        </div>
      );
    case "ticket_created":
      return <TicketCard ticketKey={entry.key} title={entry.title} status={entry.status} what="Created" />;
    case "ticket_moved":
      return <TicketCard ticketKey={entry.key} title={entry.title} status={entry.to} what={`${statusLabel(entry.from)} → ${statusLabel(entry.to)}`} />;
    case "event_batch":
      return (
        <div className="cos-line" data-testid="cos-batch" title={entry.digest || undefined}>
          <Icon name="zap" size={12} />
          Woke for {entry.eventIds.length} event{entry.eventIds.length === 1 ? "" : "s"}
          {entry.digest && <span className="dim"> · {entry.digest}</span>}
        </div>
      );
  }
});

/** A ticket the chief made or moved: key, title and status, opening the ticket. The live status wins over the entry's. */
function TicketCard({ ticketKey, title, status, what }: { ticketKey: string; title: string; status: string; what: string }) {
  const { state, navigate } = useStore();
  const live = ticketByKey(state, ticketKey);
  const shown = live?.status ?? status;
  return (
    <button
      className="cos-card"
      data-testid="cos-ticket-card"
      data-ticket={ticketKey}
      onClick={() => navigate({ view: "board", projectId: null, ticketKey, tab: "spec" })}
      title={`Open ${ticketKey}`}
    >
      {isStatus(shown) ? <StatusDot status={shown} /> : <span className="status-dot" />}
      <span className="cos-card-key mono">{ticketKey}</span>
      <span className="cos-card-title truncate">{live?.title ?? title}</span>
      <span className="cos-card-what dim">{what}</span>
      <span className="cos-card-status">{statusLabel(shown)}</span>
    </button>
  );
}

function Composer({ chief, onSent }: { chief: Cos; onSent: () => void }) {
  const { client } = useStore();
  const act = useAction();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const canSend = chief.enabled && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await act(() => client.sendCosMessage(chief.ticketId, text.trim()));
    setSending(false);
    if (ok) {
      setText("");
      onSent();
    }
  };

  return (
    <div className="composer" data-testid="cos-composer">
      <div className="composer-row">
        <textarea
          className="composer-input"
          rows={1}
          data-testid="cos-composer-input"
          aria-label="Message the chief of staff"
          placeholder={chief.enabled ? "Message the chief of staff" : "Turn the chief of staff on to talk to it"}
          disabled={!chief.enabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary composer-send" data-testid="cos-send" disabled={!canSend} onClick={() => void send()} aria-label="Send" title="Send, and skip triage">
          {sending ? <span className="spinner" /> : <Icon name="arrowUp" strokeWidth={2.25} />}
          <span className="kbd" aria-hidden>
            {MOD}↩
          </span>
        </button>
      </div>
    </div>
  );
}
