import Foundation

// Port of mobile/src/lib/newSession.ts: the "Skip agent review" hint in ticket settings (Details
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
}
