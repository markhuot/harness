// Conductor → "Tickets" tab: a live list of the conductor's child tickets, derived from the
// store (ticket.upserted / activity.added keep it current; nothing polls).

import { useEffect, useMemo, useRef } from "react";
import { keyLabel, type Ticket } from "@harness/shared";
import { useStore } from "../state/store";
import { attentionOf, childrenOfTicket, depChipTitle, depStates, groupChildren, hasCustomDriver, isWorking, latestActivity, NEWS_KINDS, plainText, progressLabel, progressOf, workingTitle } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { DriverBadge, ReviewMark, STATUS_LABEL, StatusDot, StatusPill, TicketKey } from "../components/bits";
import { ProgressBar } from "../components/Conductor";
import { useBoardScope, useOpenTicket, usePane, usePaneScope } from "../components/paneContext";
import { keysArea } from "../components/commands";
import { useRovingList } from "../components/useRovingList";
import { dragProps, ticketContextMenu } from "../components/paneDrag";

/** Ticket.model arrives with per-ticket model selection; read it defensively. */
const modelOf = (t: Ticket) => (t as Ticket & { model?: string | null }).model ?? null;

export function ChildrenTab({ ticket }: { ticket: Ticket }) {
  const { state, client, dispatch, epoch } = useStore();
  const openTicket = useOpenTicket();
  const children = useMemo(() => childrenOfTicket(state.tickets, ticket.id), [state.tickets, ticket.id]);
  const progress = useMemo(() => progressOf(children), [children]);
  const groups = useMemo(() => groupChildren(children), [children]);

  // The store backfills Activity for moving tickets; fill in the rest (older done children).
  const fetched = useRef(new Set<string>());
  useEffect(() => {
    for (const c of children) {
      if (state.activity[c.sessionId] || fetched.current.has(c.id)) continue;
      fetched.current.add(c.id);
      client
        .listActivity(c.key)
        .then((activity) => dispatch({ type: "activity", sessionId: c.sessionId, activity }))
        .catch(() => {});
    }
  }, [children, client, dispatch, state.activity]);
  useEffect(() => fetched.current.clear(), [epoch]);

  const open = (key: string) => openTicket(key);

  // The rows are one Tab stop; j/k (↑/↓) move between them before the ticket pane scrolls. The
  // container is the same element with or without children, so the hook keeps watching it.
  const listRef = useRef<HTMLDivElement>(null);
  const owner = `children:${usePane()?.paneId ?? ticket.id}`;
  useRovingList(listRef, { owner });

  if (children.length === 0) {
    return (
      <div className="children-tab" ref={listRef} {...keysArea("list", owner)}>
        <div className="empty" data-testid="children-empty">
          <Icon name="conductor" />
          <strong>No tickets yet</strong>
          The conductor hasn't created any tickets yet.
        </div>
      </div>
    );
  }

  return (
    <div className="children-tab" ref={listRef} {...keysArea("list", owner)}>
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
              <ChildRow key={c.id} child={c} onOpen={open} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ChildRow({ child: c, onOpen }: { child: Ticket; onOpen: (key: string) => void }) {
  const { state } = useStore();
  const deps = depStates(state.tickets, c, state.keyAliases);
  const latest = latestActivity(state, c.sessionId, NEWS_KINDS);
  const attention = attentionOf(c);
  const model = modelOf(c);
  const showDriver = hasCustomDriver(state, c);
  const quietDone = c.status === "done";
  const paneId = usePane()?.paneId ?? null;
  const scope = usePaneScope();
  const boardScope = useBoardScope();

  return (
    <div
      role="button"
      // The roving list (ChildrenTab) sets tabIndex: the current row 0, the rest -1.
      data-roving-item
      className={`child-row ${attention ? `attn attn-${attention}` : ""} ${quietDone ? "is-done" : ""}`}
      data-key={c.key}
      onClick={() => onOpen(c.key)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(c.key))}
      // Drag onto a half of this pane (or any other) to see the child beside its conductor, or out of the window to open it in one.
      {...dragProps({ kind: "ticket", ticketKey: c.key }, { chip: keyLabel(c), title: c.title }, boardScope)}
      onContextMenu={(e) => void ticketContextMenu(e, scope, c.key, () => onOpen(c.key), paneId, undefined, boardScope)}
    >
      <div className="child-main">
        <div className="child-top">
          <span className="child-key">
            <TicketKey ticket={c} />
          </span>
          <span className="child-title">{c.title || "Untitled"}</span>
          {isWorking(state.tickets, c) && <span className="spinner" title={workingTitle(c)} />}
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
          latest && <div className="child-summary">{plainText(latest.body)}</div>
        )}

        {(deps.length > 0 || showDriver || model) && (
          <div className="child-foot">
            {deps.map((d) => (
              <button
                key={d.key}
                className={`chip link-chip ${d.state}`}
                data-dep-state={d.state}
                title={d.state === "pending" && d.ticket ? `Waiting on ${keyLabel(d.ticket)} (${STATUS_LABEL[d.ticket.status].toLowerCase()})` : depChipTitle(d)}
                disabled={!d.ticket}
                onClick={(e) => {
                  e.stopPropagation();
                  if (d.ticket) onOpen(d.ticket.key);
                }}
              >
                {d.state === "done" ? <Icon name="check" size={9} strokeWidth={3} /> : d.state === "pending" ? <Icon name="clock" size={9} /> : null}
                <span className="chip-label">{d.state === "done" ? "after" : d.state === "pending" ? "waiting on" : "depends on"}</span>
                {d.ticket ? <TicketKey ticket={d.ticket} /> : d.key}
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
