import Foundation

// The "Skip agent review" and "Skip human review" hints in ticket settings (Details
// and a draft's Options).

public enum NewSession {
    /// What flipping the ticket's "Skip agent review" switch does now (UpdateTicketBody.skipAgentReview).
    public static func skipReviewHint(status: TicketStatus, agentReview: ReviewState, skipAgentReview: Bool?) -> String {
        let skip = skipAgentReview == true
        if status == .review, skip, agentReview == .skipped { return "Off starts the review" }
        if status == .review, !skip, agentReview == .pending { return "On skips the pending review" }
        return "When it's submitted"
    }

    public static func skipReviewHint(_ t: Ticket) -> String {
        skipReviewHint(status: t.status, agentReview: t.agentReview, skipAgentReview: t.skipAgentReview)
    }

    /// What flipping the ticket's "Skip human review" switch does now (UpdateTicketBody.skipHumanReview).
    /// `requireHumanReview` is the project's; nil (no project loaded) counts as true.
    public static func skipHumanReviewHint(
        status: TicketStatus, agentReview: ReviewState, humanReview: ReviewState,
        skipAgentReview: Bool?, skipHumanReview: Bool?, requireHumanReview: Bool?
    ) -> String {
        let skip = skipHumanReview == true
        if requireHumanReview == false { return "This project doesn't ask for a human review" }
        if status == .review, !skip, humanReview == .pending {
            return agentReview.passed ? "Turning it on lands the ticket now" : "Turning it on lands the ticket once its agent review passes"
        }
        if status == .review, skip, humanReview == .approved { return "Turning it off waits on your approval again" }
        return skipAgentReview == true ? "Lands as soon as it's submitted" : "Lands as soon as the agent review approves it"
    }

    public static func skipHumanReviewHint(_ t: Ticket, project: Project?) -> String {
        skipHumanReviewHint(
            status: t.status, agentReview: t.agentReview, humanReview: t.humanReview,
            skipAgentReview: t.skipAgentReview, skipHumanReview: t.skipHumanReview,
            requireHumanReview: project?.requireHumanReview
        )
    }
}
