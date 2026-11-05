// What the composer's Needs you panel shows first for a blocked ticket (views/BlockedCallout.tsx), decided
// from the ticket alone: its blockedReason, restart time and pending approval, so it needs neither
// the Activity feed nor a loaded spec. The callout is display-only: it is never part of the spec.
// There's no Unblock: the human answers by sending a message, and the agent unblocks itself.

import type { PendingApproval, Ticket } from "@harness/shared";
import { restartsAt } from "@harness/shared/state";

export type BlockedCallout =
  | { kind: "none" }
  /** Waiting on the human's answer, which they send as a message. */
  | { kind: "question"; question: string }
  /** A usage limit: restarts by itself at `at`; `reason` is the run's error. */
  | { kind: "restart"; at: number; reason: string }
  /** A tool waits on an allow or deny. */
  | { kind: "approval"; approval: PendingApproval };

export function blockedCallout(ticket: Ticket): BlockedCallout {
  if (ticket.status !== "blocked" || ticket.draft) return { kind: "none" };
  if (ticket.pendingApproval) return { kind: "approval", approval: ticket.pendingApproval };
  const at = restartsAt(ticket);
  if (at !== null) return { kind: "restart", at, reason: (ticket.blockedReason ?? "").trim() };
  return { kind: "question", question: (ticket.blockedReason ?? "").trim() };
}
