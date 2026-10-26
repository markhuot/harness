// The blocked ticket's status, question and buttons at the top of the Spec tab, so the human can
// answer the agent without leaving the spec. Display-only: it is drawn above the spec, never part
// of its text, revisions, diff or Source editor. What it shows comes from state/blockedCallout.ts;
// its Unblock runs the same action as the header's, through its own runner (and dialog).

import { useState } from "react";
import type { Ticket } from "@harness/shared";
import { restartTitle } from "@harness/shared/state";
import { blockedCallout } from "../state/blockedCallout";
import { useTicketActionRunner } from "../components/TicketActionHost";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ApprovalCard } from "./Approval";

/** A question longer than this many characters (or lines) is clamped until Show all. */
const CLAMP_CHARS = 600;
const CLAMP_LINES = 10;

export function BlockedCallout({ ticket }: { ticket: Ticket }) {
  const runner = useTicketActionRunner();
  const callout = blockedCallout(ticket);
  if (callout.kind === "none") return null;
  if (callout.kind === "approval") return <ApprovalCard key={callout.approval.id} ticket={ticket} approval={callout.approval} />;
  const reason = callout.kind === "restart" ? callout.reason : callout.question;
  const at = callout.kind === "restart" ? new Date(callout.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <section className="blocked-callout" data-testid="blocked-callout" data-kind={callout.kind}>
      <div className="activity-meta">
        <Icon name="alert" size={12} />
        <strong>{at ? `Blocked · restarts at ${at}` : "Blocked · waiting on your answer"}</strong>
      </div>
      {reason && <ClampedMarkdown key={reason} text={reason} />}
      {at && <span className="muted" title={restartTitle(at)}>{restartTitle(at)}</span>}
      {callout.kind === "question" && callout.unblock && (
        <div className="blocked-callout-actions">
          <button className="btn btn-primary" data-testid="blocked-callout-unblock" disabled={!!ticket.compacting} onClick={() => runner.run(ticket, { id: "unblock" })}>
            <Icon name="play" /> Unblock
          </button>
        </div>
      )}
      {runner.modals}
    </section>
  );
}

function ClampedMarkdown({ text }: { text: string }) {
  const long = text.length > CLAMP_CHARS || text.split("\n").length > CLAMP_LINES;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={long && !open ? "blocked-callout-body is-clamped" : "blocked-callout-body"}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="activity-details-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}
