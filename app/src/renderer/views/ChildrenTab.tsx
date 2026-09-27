// Conductor → "Tickets" tab: a live list of the conductor's child tickets, derived from the
// store (ticket.upserted / summary.added keep it current; nothing polls).

import { useEffect, useMemo, useRef } from "react";
import type { Ticket } from "@harness/shared";
import { useStore } from "../state/store";
import { attentionOf, childrenOfTicket, depChipTitle, depStates, groupChildren, latestSummary, plainText, progressLabel, progressOf } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { DriverBadge, ReviewMark, STATUS_LABEL, StatusDot, StatusPill } from "../components/bits";
import { ProgressBar } from "../components/Conductor";

/** Ticket.model arrives with per-ticket model selection; read it defensively. */
const modelOf = (t: Ticket) => (t as Ticket & { model?: string | null }).model ?? null;

export function ChildrenTab({ ticket }: { ticket: Ticket }) {
  const { state, client, dispatch, navigate, route, epoch } = useStore();
  const children = useMemo(() => childrenOfTicket(state.tickets, ticket.id), [state.tickets, ticket.id]);
  const progress = useMemo(() => progressOf(children), [children]);
  const groups = useMemo(() => groupChildren(children), [children]);
  const project = state.projects[ticket.projectId];
  const defaultDriver = project?.defaultDriver ?? state.settings?.defaultDriver ?? ticket.driver;

  // The store backfills summaries for moving tickets; fill in the rest (older done children).
  const fetched = useRef(new Set<string>());
  useEffect(() => {
    for (const c of children) {
      if (state.summaries[c.sessionId] || fetched.current.has(c.id)) continue;
      fetched.current.add(c.id);
      client
        .listSummaries(c.key)
        .then((summaries) => dispatch({ type: "summaries", sessionId: c.sessionId, summaries }))
        .catch(() => {});
    }
  }, [children, client, dispatch, state.summaries]);
  useEffect(() => fetched.current.clear(), [epoch]);

  const open = (key: string) => navigate({ view: "board", projectId: route.view === "board" ? route.projectId : null, ticketKey: key, tab: "summaries" });

  if (children.length === 0) {
    return (
      <div className="children-tab">
        <div className="empty" data-testid="children-empty">
          <Icon name="conductor" />
          <strong>No tickets yet</strong>
          The conductor hasn't created any tickets yet.
        </div>
      </div>
    );
  }

  return (
    <div className="children-tab">
      <div className="children-progress card-surface">
        <div className="children-progress-text" data-testid="children-progress">
          {progressLabel(progress)}
        </div>
        <ProgressBar progress={progress} />
        {progress.attention > 0 && (
          <div className="children-attn">
            <Icon name="alert" size={12} />
            {progress.attention} ticket{progress.attention === 1 ? "" : "s"} waiting on you
          </div>
        )}
      </div>

      {groups.map((g) => (
        <section key={g.status} className="children-group" data-status={g.status}>
          <div className="children-group-head">
            <StatusDot status={g.status} />
            <span>{STATUS_LABEL[g.status]}</span>
            <span className="column-count">{g.tickets.length}</span>
          </div>
          <div className="children-list card-surface">
            {g.tickets.map((c) => (
              <ChildRow key={c.id} child={c} defaultDriver={defaultDriver} onOpen={open} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ChildRow({ child: c, defaultDriver, onOpen }: { child: Ticket; defaultDriver: string; onOpen: (key: string) => void }) {
  const { state } = useStore();
  const deps = depStates(state.tickets, c, state.keyAliases);
  const summary = latestSummary(state, c.sessionId);
  const attention = attentionOf(c);
  const model = modelOf(c);
  const showDriver = c.driver !== defaultDriver;
  const quietDone = c.status === "done";

  return (
    <div
      role="button"
      tabIndex={0}
      className={`child-row ${attention ? `attn attn-${attention}` : ""} ${quietDone ? "is-done" : ""}`}
      data-key={c.key}
      onClick={() => onOpen(c.key)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(c.key))}
    >
      <div className="child-main">
        <div className="child-top">
          <span className="child-key">{c.key}</span>
          <span className="child-title">{c.title || "Untitled"}</span>
          {c.busy && <span className="spinner" title="Agent working" />}
          {c.status === "review" && (
            <span className="card-reviews">
              <ReviewMark who="agent" state={c.agentReview} />
              <ReviewMark who="human" state={c.humanReview} />
            </span>
          )}
          <StatusPill status={c.status} />
        </div>

        {c.pendingApproval ? (
          <div className="child-note note-approval">
            <Icon name="lock" size={11} />
            <span>
              Needs approval: <strong>{c.pendingApproval.toolName.replace(/^mcp__[^_]+__/, "")}</strong>
            </span>
          </div>
        ) : c.status === "blocked" ? (
          <div className="child-note note-blocked">
            <Icon name="alert" size={11} />
            <span>{c.blockedReason || "Blocked"}</span>
          </div>
        ) : (
          summary && <div className="child-summary">{plainText(summary.body)}</div>
        )}

        {(deps.length > 0 || showDriver || model) && (
          <div className="child-foot">
            {deps.map((d) => (
              <button
                key={d.key}
                className={`chip link-chip ${d.state}`}
                data-dep-state={d.state}
                title={d.state === "pending" && d.ticket ? `Waiting on ${d.key} (${STATUS_LABEL[d.ticket.status].toLowerCase()})` : depChipTitle(d)}
                disabled={!d.ticket}
                onClick={(e) => {
                  e.stopPropagation();
                  if (d.ticket) onOpen(d.ticket.key);
                }}
              >
                {d.state === "done" ? <Icon name="check" size={9} strokeWidth={3} /> : d.state === "pending" ? <Icon name="clock" size={9} /> : null}
                <span className="chip-label">{d.state === "done" ? "after" : d.state === "pending" ? "waiting on" : "depends on"}</span>
                {d.ticket?.key ?? d.key}
              </button>
            ))}
            <div className="grow" />
            {showDriver && <DriverBadge driver={c.driver} />}
            {model && (
              <span className="badge badge-outline mono" title={`Model: ${model}`}>
                {model}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
