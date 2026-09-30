import { useRef, useState } from "react";
import { keyLabel, type Session, type Watcher } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { dispatchedKey as outcomeKey, ticketByKey, TRIAGE_LABEL, triageSessions, watcherStatus } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { FileLinkScope, Markdown } from "../components/Markdown";
import { relativeTime, useNow } from "../components/bits";
import { keysArea } from "../components/commands";
import { useRovingList } from "../components/useRovingList";
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
  // The sessions are one Tab stop; j/k (↑/↓) move between them, Enter opens one.
  const listRef = useRef<HTMLDivElement>(null);
  useRovingList(listRef, { owner: "inbox" });

  return (
    <div className="inbox">
      <div className="inbox-list">
        <header className="view-header">
          <div className="view-title">
            <Icon name="inbox" /> Inbox
          </div>
          <span className="muted">{sessions.length}</span>
        </header>
        <div className="view-body" ref={listRef} {...keysArea("list", "inbox")}>
          <WatcherStrip />
          {sessions.length === 0 && (
            <div className="empty">
              <Icon name="inbox" />
              <strong>Inbox zero</strong>
              Output from watchers is triaged here before it becomes tickets.
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`inbox-item ${s.id === selectedId ? "active" : ""}`}
              data-roving-item
              aria-current={s.id === selectedId || undefined}
              onClick={() => navigate({ view: "inbox", sessionId: s.id })}>
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

/** Every watcher and what its process is doing now; paused ones are muted, as in Settings. */
function WatcherStrip() {
  const { state } = useStore();
  const now = useNow(1000);
  const watchers = Object.values(state.watchers).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  if (watchers.length === 0) return null;
  return (
    <section className="watcher-strip" aria-label="Watchers">
      {watchers.map((w) => (
        <WatcherRow key={w.id} watcher={w} now={now} />
      ))}
    </section>
  );
}

function WatcherRow({ watcher: w, now }: { watcher: Watcher; now: number }) {
  const { client, navigate } = useStore();
  const act = useAction();
  const [expanded, setExpanded] = useState(false);
  const s = watcherStatus(w, now);
  return (
    <div className={`watcher-row ${w.enabled ? "" : "muted-row"}`} data-tone={s.tone}>
      <div className="row">
        <span className="watcher-dot" data-tone={s.tone} data-state={w.live?.state ?? "unknown"} />
        <button className="watcher-name truncate" title="Watcher settings" onClick={() => navigate({ view: "settings", section: "watchers" })}>
          {w.name}
        </button>
        <span className="badge">{w.mode === "loop" ? "Loop" : `Every ${w.intervalSec}s`}</span>
        <div className="grow" />
        <span className={`badge ${TONE_CLASS[s.tone]}`}>{s.label}</span>
      </div>
      <div className="row watcher-sub">
        <span className="muted truncate">{s.detail}</span>
        <div className="grow" />
        {s.error && w.live?.state !== "running" && (
          <button className="btn btn-sm btn-ghost" onClick={() => void act(() => client.runWatcher(w.id), `Restarting ${w.name}`)}>
            <Icon name="play" size={10} /> Retry now
          </button>
        )}
      </div>
      {s.error && (
        <button className={`watcher-error mono ${expanded ? "expanded" : ""}`} title={expanded ? "Show less" : s.error} onClick={() => setExpanded((v) => !v)}>
          {s.error}
        </button>
      )}
    </div>
  );
}

function TriageSession({ session }: { session: Session }) {
  const { state, navigate } = useStore();
  // "Dispatched to FOO-123" → link the ticket when it exists locally.
  const dispatchedKey = outcomeKey(session);
  const dispatched = dispatchedKey ? ticketByKey(state, dispatchedKey) : undefined;
  // A triage session has no project of its own: file links resolve in the project it dispatched to.
  return (
    <FileLinkScope projectId={dispatched?.projectId ?? null}>
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
              Open {keyLabel(dispatched)} <Icon name="chevronRight" size={12} />
            </button>
          )}
        </div>
      )}
      <Transcript sessionId={session.id} emptyHint="The triage agent's reasoning appears here." />
    </FileLinkScope>
  );
}
