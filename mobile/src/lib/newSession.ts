// The "Skip agent review" hint in ticket settings (Details and a draft's Options).
import type { Ticket } from "@harness/shared";

/** What flipping the ticket's "Skip agent review" switch does now (UpdateTicketBody.skipAgentReview). */
export function skipReviewHint(t: Pick<Ticket, "status" | "agentReview" | "skipAgentReview">): string {
  if (t.status === "review" && t.skipAgentReview && t.agentReview === "skipped") return "Off starts the review";
  if (t.status === "review" && !t.skipAgentReview && t.agentReview === "pending") return "On skips the pending review";
  return "When it's submitted";
}
