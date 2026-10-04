// The Spec tab: the ticket's living document (DESIGN.md "Spec revisions and attachments"), with a
// history bar to step back through its revisions and a Show changes toggle that keeps the rendered
// spec and marks what the revision on show changed from the one before it (MarkdownDiff): added
// text green, removed text red and struck through, in place.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SpecRevisionAuthor, Ticket } from "@harness/shared";
import { depChipTitle, dependencyStates, diffUnchanged, specBody, specDiff } from "@harness/shared/state";
import { useStore } from "../state/store";
import { FOLLOW_LATEST, scrubTo, shownRevision, stepRevision, type SpecHistory } from "../state/specHistory";
import { Icon } from "../components/Icon";
import { Markdown, MarkdownDiff } from "../components/Markdown";
import { relativeTime, Switch, TicketKey, useNow } from "../components/bits";
import { PromptAttachmentList } from "../components/PromptAttachments";

const AUTHOR_LABEL: Record<SpecRevisionAuthor, string> = { agent: "Agent", human: "You", system: "Harness" };

export function SpecTab({ ticket }: { ticket: Ticket }) {
  const { state, client, dispatch, epoch } = useStore();
  const now = useNow();
  const latest = ticket.specRevision ?? 1;
  const revisions = state.specRevisions[ticket.id];
  const [history, setHistory] = useState<SpecHistory>(FOLLOW_LATEST);
  const [showChanges, setShowChanges] = useState(false);
  const [bodyErrors, setBodyErrors] = useState<Record<number, Error>>({});
  const shown = shownRevision(history, latest);
  const body = specBody(state, ticket.id, shown);
  /** Show changes compares the revision on show with the one before it. */
  const comparing = showChanges && shown > 1;
  const prevBody = comparing ? specBody(state, ticket.id, shown - 1) : undefined;
  const info = revisions?.find((r) => r.rev === shown);
  const deps = dependencyStates(state, ticket);

  // The revision list (metadata only); spec.revised events keep it current once it's loaded.
  useEffect(() => {
    let live = true;
    client.specRevisions(ticket.key).then(
      (list) => live && dispatch({ type: "specRevisions", ticketId: ticket.id, revisions: list }),
      () => {},
    );
    return () => void (live = false);
  }, [client, dispatch, ticket.key, ticket.id, epoch]);

  // An earlier revision's body, fetched when it's first shown, and the one before it for Show changes.
  const fetchError = (rev: number) => (e: unknown) => setBodyErrors((m) => ({ ...m, [rev]: e instanceof Error ? e : new Error(String(e)) }));
  useRevisionBody(ticket, shown, body === undefined && !bodyErrors[shown], fetchError(shown));
  useRevisionBody(ticket, shown - 1, comparing && prevBody === undefined && !bodyErrors[shown - 1], fetchError(shown - 1));

  const diff = useMemo(() => (body !== undefined && prevBody !== undefined ? specDiff(prevBody, body) : undefined), [body, prevBody]);
  const unchanged = diff !== undefined && diffUnchanged(diff);
  const bodyError = bodyErrors[shown] ?? (comparing ? bodyErrors[shown - 1] : undefined);

  const step = (delta: number) => setHistory((h) => stepRevision(h, latest, delta));

  return (
    <div className="spec-tab">
      <div className="spec-history" data-testid="spec-history">
        <button className="btn btn-ghost btn-icon btn-sm" disabled={shown <= 1} onClick={() => step(-1)} title="Previous revision" aria-label="Previous revision">
          <Icon name="chevronLeft" />
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" disabled={shown >= latest} onClick={() => step(1)} title="Next revision" aria-label="Next revision">
          <Icon name="chevronRight" />
        </button>
        <span className="spec-history-meta truncate">
          <strong>
            Rev {shown} of {latest}
          </strong>
          {info && (
            <>
              {" · "}
              {AUTHOR_LABEL[info.author]}
              {info.createdAt > 0 && (
                <>
                  {" · "}
                  <span title={new Date(info.createdAt).toLocaleString()}>{relativeTime(info.createdAt, now)}</span>
                </>
              )}
              {info.note && (
                <>
                  {" · "}
                  <em>{info.note}</em>
                </>
              )}
            </>
          )}
        </span>
        {(info?.approvedBaseline || ticket.specBaselineRevision === shown) && (
          <span className="chip done spec-baseline" title="The revision approved when the ticket was started">
            <Icon name="check" size={9} strokeWidth={3} />
            Approved plan
          </span>
        )}
        {history.pinned !== null && (
          <button className="btn btn-ghost btn-sm" onClick={() => setHistory(FOLLOW_LATEST)} title="Back to the newest revision">
            Latest
          </button>
        )}
        <div className="grow" />
        {showChanges && latest > 1 && (shown === 1 || unchanged) && (
          <span className="spec-diff-note">{shown === 1 ? "First revision: nothing to compare" : `No changes from rev ${shown - 1}`}</span>
        )}
        {latest > 1 && <Switch checked={showChanges} onChange={setShowChanges} label="Show changes" />}
      </div>
      {latest > 1 && (
        <input
          className="spec-scrub"
          type="range"
          min={1}
          max={latest}
          step={1}
          value={shown}
          aria-label="Spec revision"
          onChange={(e) => setHistory(scrubTo(Number(e.target.value), latest))}
        />
      )}
      <div className="spec-body">
        {deps.length > 0 && (
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <span className="section-title">Depends on</span>
            {deps.map((d) => (
              <span key={d.key} className={`chip ${d.state}`} data-dep-state={d.state} title={depChipTitle(d)}>
                {d.done && <Icon name="check" size={9} strokeWidth={3} />}
                {d.ticket ? <TicketKey ticket={d.ticket} /> : d.key}
              </span>
            ))}
          </div>
        )}
        {body === undefined || (comparing && prevBody === undefined) ? (
          bodyError ? (
            <div className="empty">Couldn't load this revision: {bodyError.message}</div>
          ) : (
            <div className="empty">
              <div className="spinner" />
            </div>
          )
        ) : comparing && prevBody !== undefined && diff && (body.trim() || prevBody.trim()) ? (
          <section className="spec-doc" data-testid="spec-doc" data-changes={`${shown - 1}-${shown}`}>
            <MarkdownDiff diff={diff} before={prevBody} after={body} />
          </section>
        ) : body.trim() ? (
          <section className="spec-doc" data-testid="spec-doc">
            <Markdown text={body} />
          </section>
        ) : (
          <div className="empty">
            <Icon name="fileText" />
            <strong>No spec yet</strong>
            {ticket.status === "planning" ? "The planning agent writes the plan here." : "Write one in Details, or ask the agent to."}
          </div>
        )}
        {!!ticket.promptAttachments?.length && (
          <section className="spec-prompt-attachments" data-testid="spec-prompt-attachments">
            <span className="section-title">Attachments</span>
            <PromptAttachmentList
              ticketKey={ticket.key}
              items={ticket.promptAttachments}
              annotations={ticket.promptAnnotations}
              annotate={(index, a) => ({ source: { kind: "prompt-attachment", index, name: a.name } })}
            />
          </section>
        )}
      </div>
    </div>
  );
}

/** Fetch revision `rev`'s body into the store while `needed`; `onError` hears a failed fetch. */
function useRevisionBody(ticket: Ticket, rev: number, needed: boolean, onError: (e: unknown) => void) {
  const { client, dispatch } = useStore();
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    if (!needed) return;
    let live = true;
    client.specRevision(ticket.key, rev).then(
      (revision) => live && dispatch({ type: "specRevision", ticketId: ticket.id, revision }),
      (e) => live && report.current(e),
    );
    return () => void (live = false);
  }, [client, dispatch, ticket.key, ticket.id, rev, needed]);
}
