// What the Spec tab shows above the spec for a blocked ticket (views/BlockedCallout.tsx), decided
// from the ticket alone: its blockedReason, restart time and pending approval, so it needs neither
// the Activity feed nor a loaded spec. The callout is display-only: it is never part of the spec.

import type { PendingApproval, Ticket } from "@harness/shared";
import { restartsAt } from "@harness/shared/state";
import { canUnblock } from "./ticketActions";

export type BlockedCallout =
  | { kind: "none" }
  /** Waiting on the human's answer. `unblock` is whether the Unblock button applies (the header's gate). */
  | { kind: "question"; question: string; unblock: boolean }
  /** A usage limit: restarts by itself at `at`; `reason` is the run's error. */
  | { kind: "restart"; at: number; reason: string }
  /** A tool waits on an allow or deny. */
  | { kind: "approval"; approval: PendingApproval };

export function blockedCallout(ticket: Ticket): BlockedCallout {
  if (ticket.status !== "blocked" || ticket.draft) return { kind: "none" };
  if (ticket.pendingApproval) return { kind: "approval", approval: ticket.pendingApproval };
  const at = restartsAt(ticket);
  if (at !== null) return { kind: "restart", at, reason: (ticket.blockedReason ?? "").trim() };
  return { kind: "question", question: (ticket.blockedReason ?? "").trim(), unblock: canUnblock(ticket) };
}
