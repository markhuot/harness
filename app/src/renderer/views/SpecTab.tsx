// The Spec tab: the ticket's living document (DESIGN.md "Spec revisions and attachments"), with a
// history bar to step back through its revisions and a Show changes toggle that draws the diff of
// the revision on show against the one before it, in the same diff viewer chat diffs use.

import { useEffect, useState } from "react";
import type { SpecRevisionAuthor, Ticket } from "@harness/shared";
import { depChipTitle, dependencyStates, specBody } from "@harness/shared/state";
import { useStore } from "../state/store";
import { FOLLOW_LATEST, scrubTo, shownRevision, specDiffPatch, stepRevision, type SpecHistory } from "../state/specHistory";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { FencedCode } from "../components/Code";
import { relativeTime, Switch, TicketKey, useNow } from "../components/bits";

const AUTHOR_LABEL: Record<SpecRevisionAuthor, string> = { agent: "Agent", human: "You", system: "Harness" };

export function SpecTab({ ticket }: { ticket: Ticket }) {
  const { state, client, dispatch, epoch } = useStore();
  const now = useNow();
  const latest = ticket.specRevision ?? 1;
  const revisions = state.specRevisions[ticket.id];
  const [history, setHistory] = useState<SpecHistory>(FOLLOW_LATEST);
  const [showChanges, setShowChanges] = useState(false);
  /** Diffs fetched so far, by the revision they lead to (rev - 1 → rev); revisions never change */
  const [diffs, setDiffs] = useState<Record<number, string | Error>>({});
  const [bodyErrors, setBodyErrors] = useState<Record<number, Error>>({});
  const shown = shownRevision(history, latest);
  const body = specBody(state, ticket.id, shown);
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

  // An earlier revision's body, fetched when it's first shown.
  useEffect(() => {
    if (body !== undefined || bodyErrors[shown]) return;
    let live = true;
    client.specRevision(ticket.key, shown).then(
      (revision) => live && dispatch({ type: "specRevision", ticketId: ticket.id, revision }),
      (e) => live && setBodyErrors((m) => ({ ...m, [shown]: e instanceof Error ? e : new Error(String(e)) })),
    );
    return () => void (live = false);
  }, [client, dispatch, ticket.key, ticket.id, shown, body, bodyErrors]);

  const diff = diffs[shown];
  useEffect(() => {
    if (!showChanges || shown < 2 || diff !== undefined) return;
    let live = true;
    client.specDiff(ticket.key, shown - 1, shown).then(
      (d) => live && setDiffs((m) => ({ ...m, [shown]: d.diff })),
      (e) => live && setDiffs((m) => ({ ...m, [shown]: e instanceof Error ? e : new Error(String(e)) })),
    );
    return () => void (live = false);
  }, [client, ticket.key, shown, showChanges, diff]);

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
        {showChanges && latest > 1 ? (
          <SpecChanges rev={shown} diff={diff} />
        ) : body === undefined ? (
          bodyErrors[shown] ? (
            <div className="empty">Couldn't load this revision: {bodyErrors[shown].message}</div>
          ) : (
            <div className="empty">
              <div className="spinner" />
            </div>
          )
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
      </div>
    </div>
  );
}

function SpecChanges({ rev, diff }: { rev: number; diff: string | Error | undefined }) {
  if (rev < 2) return <div className="empty">Revision 1 is the first: there's nothing before it to compare.</div>;
  if (diff === undefined)
    return (
      <div className="empty">
        <div className="spinner" />
      </div>
    );
  if (diff instanceof Error) return <div className="empty">Couldn't load the changes: {diff.message}</div>;
  if (!diff) return <div className="empty">Revision {rev} didn't change the text.</div>;
  return (
    <div className="spec-diff" data-testid="spec-diff">
      <div className="section-title">
        Changes from rev {rev - 1} to rev {rev}
      </div>
      <FencedCode text={specDiffPatch(diff)} lang="diff" />
    </div>
  );
}
