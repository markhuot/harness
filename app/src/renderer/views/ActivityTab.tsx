// The Activity tab: the ticket's typed timeline (DESIGN.md "Activity"), oldest first and stuck to
// the bottom. Each kind has its own icon and look: a blocked entry is an attention card with the
// question, review decisions show their round and commit, messages and answers read as a
// conversation, and failures and system entries stay muted.

import type { Ticket } from "@harness/shared";
import { useStore } from "../state/store";
import { ACTIVITY_KIND as KIND, activityHeading, openQuestionId } from "../state/activity";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { relativeTime, useNow } from "../components/bits";
import { useStickToBottom } from "../components/stickToBottom";

export function ActivityTab({ ticket }: { ticket: Ticket }) {
  const { state } = useStore();
  const now = useNow();
  const list = state.activity[ticket.sessionId] ?? [];
  // Newest is last; open scrolled to it and follow new entries until the user scrolls up.
  const box = useStickToBottom<HTMLDivElement>();
  const openQuestion = openQuestionId(list, ticket.status);

  return (
    <div className="activity" ref={box}>
      {list.length === 0 ? (
        <div className="empty">
          <Icon name="clock" />
          <strong>No activity yet</strong>
          Notes, review rounds, questions and the messages you send from Spec or Activity show up here.
        </div>
      ) : (
        <ol className="activity-list">
          {list.map((e) => {
            const kind = KIND[e.kind] ?? KIND.system;
            const time = (
              <span className="muted" title={new Date(e.createdAt).toLocaleString()}>
                {relativeTime(e.createdAt, now)}
              </span>
            );
            if (e.kind === "blocked") {
              const question = e.meta?.question || e.body;
              return (
                <li key={e.id} className={`activity-entry activity-blocked ${openQuestion === e.id ? "is-open" : ""}`} data-kind={e.kind}>
                  <div className="activity-card">
                    <div className="activity-meta">
                      <Icon name="alert" size={12} />
                      <strong>{openQuestion === e.id ? "Waiting on your answer" : kind.label}</strong>
                      {time}
                    </div>
                    <Markdown text={question} />
                  </div>
                </li>
              );
            }
            if (e.kind === "message" || e.kind === "answer") {
              return (
                <li key={e.id} className={`activity-entry activity-chat activity-${e.kind}`} data-kind={e.kind}>
                  <div className="activity-bubble">
                    <div className="activity-meta">
                      <strong>{kind.label}</strong>
                      {time}
                    </div>
                    <Markdown text={e.body} />
                  </div>
                </li>
              );
            }
            return (
              <li key={e.id} className={`activity-entry activity-${e.kind}`} data-kind={e.kind}>
                <span className="activity-icon">
                  <Icon name={kind.icon} size={11} />
                </span>
                <div className="activity-main">
                  <div className="activity-meta">
                    <strong>{activityHeading(e)}</strong>
                    {time}
                  </div>
                  {e.body && <Markdown text={e.body} />}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
