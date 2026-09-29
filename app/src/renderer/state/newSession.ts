// The ticket settings' "Skip agent review" hint (components/TicketSettings.tsx).
import type { Ticket } from "@harness/shared";

/** What flipping the ticket's "Skip agent review" switch does now (UpdateTicketBody.skipAgentReview). */
export function skipReviewHint(t: Pick<Ticket, "status" | "agentReview" | "skipAgentReview">): string {
  if (t.status === "review" && t.skipAgentReview && t.agentReview === "skipped") return "Turning it off starts the agent review now";
  if (t.status === "review" && !t.skipAgentReview && t.agentReview === "pending") return "Turning it on skips the pending agent review";
  return "Goes straight to your review when it's submitted";
}
