import type { Session } from "@harness/shared";
import { useStore } from "../state/store";
import { dispatchedKey as outcomeKey, ticketByKey, TRIAGE_LABEL, triageSessions } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { relativeTime, useNow } from "../components/bits";
import { Transcript } from "./Transcript";

const TONE_CLASS = { amber: "badge-amber", green: "badge-green", neutral: "", red: "badge-red" } as const;

export function TriageBadge({ session }: { session: Session }) {
  const t = TRIAGE_LABEL[session.triageStatus ?? "triaging"];
  const s = { label: t.label, cls: TONE_CLASS[t.tone] };
  return (
    <span className={`badge ${s.cls}`}>
      {session.busy && <span className="spinner" style={{ width: 9, height: 9 }} />}
      {s.label}
    </span>
  );
}

export function InboxView() {
  const { state, route, navigate } = useStore();
  const now = useNow();
  const sessions = triageSessions(state);
  const selectedId = route.view === "inbox" ? (route.sessionId ?? sessions[0]?.id ?? null) : null;
  const selected = selectedId ? state.sessions[selectedId] : undefined;

  return (
    <div className="inbox">
      <div className="inbox-list">
        <header className="view-header">
          <div className="view-title">
            <Icon name="inbox" /> Inbox
          </div>
          <span className="muted">{sessions.length}</span>
        </header>
        <div className="view-body">
          {sessions.length === 0 && (
            <div className="empty">
              <Icon name="inbox" />
              <strong>Inbox zero</strong>
              Work items from watchers are triaged here before they become tickets.
            </div>
          )}
          {sessions.map((s) => (
            <button key={s.id} className={`inbox-item ${s.id === selectedId ? "active" : ""}`} onClick={() => navigate({ view: "inbox", sessionId: s.id })}>
              <div className="row">
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {s.key}
                </span>
                <div className="grow" />
                <span className="muted" style={{ fontSize: 11 }}>
                  {relativeTime(s.createdAt, now)}
                </span>
              </div>
              <div className="inbox-title truncate">{s.title || "Untitled item"}</div>
              <div className="row">
                <TriageBadge session={s} />
                {s.outcome && <span className="truncate muted inbox-outcome">{s.outcome}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="inbox-detail">
        {selected ? (
          <TriageSession session={selected} />
        ) : (
          <>
            <header className="view-header" />
            <div className="empty" style={{ flex: 1 }}>
              Select an item
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TriageSession({ session }: { session: Session }) {
  const { state, navigate } = useStore();
  // "Dispatched to FOO-123" → link the ticket when it exists locally.
  const dispatchedKey = outcomeKey(session);
  const dispatched = dispatchedKey ? ticketByKey(state, dispatchedKey) : undefined;
  return (
    <>
      <header className="view-header">
        <span className="detail-key">{session.key}</span>
        <TriageBadge session={session} />
        <span className="truncate view-title" style={{ fontWeight: 500 }}>
          {session.title}
        </span>
        <div className="grow" />
        <span className="badge badge-outline">{session.driver}</span>
      </header>
      {session.outcome && (
        <div className={`callout ${session.triageStatus === "dispatched" ? "callout-ok" : session.triageStatus === "failed" ? "callout-blocked" : ""}`} style={{ margin: "14px 20px 0" }}>
          <Icon name={session.triageStatus === "dispatched" ? "checkCircle" : "alert"} />
          <div className="grow">
            <div className="callout-title">Outcome</div>
            <Markdown text={session.outcome} />
          </div>
          {dispatched && (
            <button className="btn btn-sm" onClick={() => navigate({ view: "board", projectId: null, ticketKey: dispatched.key, tab: "summaries" })}>
              Open {dispatched.key} <Icon name="chevronRight" size={12} />
            </button>
          )}
        </div>
      )}
      <Transcript sessionId={session.id} emptyHint="The triage agent's reasoning appears here." />
    </>
  );
}
