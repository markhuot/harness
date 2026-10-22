// A chief of staff's Listeners tab: the watchers it manages, read-only. Derived from the watchers
// the store already holds, which the service keeps current over the one socket, so creating,
// editing, switching or deleting a watcher updates the list with no refetch. To change a listener,
// ask the chief in its chat.

import { useEffect, useMemo, useState } from "react";
import { projectGroups, type Cos } from "@harness/shared";
import {
  LISTENER_STATUS_LABEL,
  chiefListeners,
  cosTitle,
  listenerCommand,
  listenerError,
  listenerNextRun,
  listenerOwner,
  listenerSchedule,
  listenerStatus,
  until,
} from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { relativeTime } from "../components/bits";
import { useStore } from "../state/store";

/** A clock that ticks every 30s, so "4m ago" and "in 1m" stay true without a re-render per watcher event. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function CosListeners({ chief, onChat }: { chief: Cos; onChat: () => void }) {
  const { state } = useStore();
  const now = useNow();
  const rows = useMemo(() => chiefListeners(Object.values(state.watchers), chief), [state.watchers, chief]);
  const owner = useMemo(() => {
    const groups = projectGroups(Object.values(state.projects));
    const names = new Map<string, string>();
    for (const c of Object.values(state.chiefs)) {
      names.set(c.ticketId, cosTitle(c, (c.groupId ? groups.find((g) => g.id === c.groupId)?.name : undefined) ?? null));
    }
    return (cosId: string): string | null => names.get(cosId) ?? null;
  }, [state.chiefs, state.projects]);
  return (
    <div className="cos-inbox cos-listeners" data-testid="cos-listeners">
      <div className="cos-inbox-bar">
        <span className="dim">What this chief of staff listens to. Ask it in chat to change them.</span>
        <div className="grow" />
        <button className="btn btn-sm" data-testid="cos-listeners-ask" onClick={onChat}>
          <Icon name="message" size={12} /> Ask the chief
        </button>
      </div>
      <div className="cos-rows">
        {rows.length === 0 && (
          <div className="empty" data-testid="cos-listeners-empty">
            <Icon name="inbox" />
            <strong>No listeners yet</strong>
            Ask the chief of staff in chat to listen for something, like PR feedback or new errors, and it sets the listener up.
          </div>
        )}
        {rows.map((w) => {
          const status = listenerStatus(w);
          const error = listenerError(w);
          const next = listenerNextRun(w);
          const tag = listenerOwner(w, chief, owner);
          return (
            <div key={w.id} className="cos-event" data-testid="cos-listener" data-listener={w.id} data-status={status}>
              <div className="cos-event-main">
                <div className="cos-event-title">
                  <span className="truncate">{w.name}</span>
                  {tag && (
                    <span className="badge" data-testid="cos-listener-owner">
                      {tag}
                    </span>
                  )}
                </div>
                <div className="cos-event-sub dim mono truncate" data-testid="cos-listener-command" title={listenerCommand(w, 400)}>
                  {listenerCommand(w)}
                </div>
                <div className="cos-event-meta dim">
                  {listenerSchedule(w)} · Last ran {w.lastRunAt ? relativeTime(w.lastRunAt, now) : "never"}
                  {next !== null && <> · Next run {until(next, now)}</>}
                </div>
              </div>
              <div className="cos-verdict">
                <span className={`cos-pill cos-listener-${status}`} data-testid="cos-listener-status">
                  {LISTENER_STATUS_LABEL[status]}
                </span>
                {error && (
                  <span className="cos-reason dim" data-testid="cos-listener-error">
                    {error}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
