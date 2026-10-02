// The ticket settings' "Skip agent review" and "Skip human review" hints (components/TicketSettings.tsx).
import { reviewPassed, type Project, type Ticket } from "@harness/shared";

/** What flipping the ticket's "Skip agent review" switch does now (UpdateTicketBody.skipAgentReview). */
export function skipReviewHint(t: Pick<Ticket, "status" | "agentReview" | "skipAgentReview">): string {
  if (t.status === "review" && t.skipAgentReview && t.agentReview === "skipped") return "Turning it off starts the agent review now";
  if (t.status === "review" && !t.skipAgentReview && t.agentReview === "pending") return "Turning it on skips the pending agent review";
  return "Goes straight to your review when it's submitted";
}

/** What flipping the ticket's "Skip human review" switch does now (UpdateTicketBody.skipHumanReview). */
export function skipHumanReviewHint(
  t: Pick<Ticket, "status" | "agentReview" | "humanReview" | "skipAgentReview" | "skipHumanReview">,
  project: Pick<Project, "requireHumanReview"> | null | undefined,
): string {
  if (project?.requireHumanReview === false) return "This project doesn't ask for a human review";
  if (t.status === "review" && !t.skipHumanReview && t.humanReview === "pending") {
    return reviewPassed(t.agentReview) ? "Turning it on lands the ticket now" : "Turning it on lands the ticket once its agent review passes";
  }
  if (t.status === "review" && t.skipHumanReview && t.humanReview === "approved") return "Turning it off waits on your approval again";
  return t.skipAgentReview ? "Lands as soon as it's submitted" : "Lands as soon as the agent review approves it";
}
