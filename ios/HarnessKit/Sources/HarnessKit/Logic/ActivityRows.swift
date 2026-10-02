import Foundation

// How the Activity tab draws each entry (DESIGN.md "Activity"): its icon, title and detail, and
// which of a few looks it takes. Blocked entries are their own attention card, review decisions
// carry their round and commit, logged messages and answers read as a conversation, and failures
// and system notes stay muted.

public enum ActivityLook: Equatable, Sendable {
    /// A row in the timeline
    case plain
    /// The human's own message: a bubble on the right
    case mine
    /// The agent's answer to it: a bubble on the left
    case reply
    /// Blocked: a card that asks for attention, with the question
    case attention
    /// An approval (review or human)
    case approved
    /// A request for changes
    case changes
    /// Failures and the service's own notes: smaller and dimmed
    case muted
}

public enum ActivityRows {
    /// The kinds a board card or a conductor's child row shows as the ticket's latest news: what
    /// the agent said or did, not questions (the card shows the blocked reason itself), messages
    /// or the service's own notes.
    public static let newsKinds: [ActivityKind] = [.note, .submitted, .reviewApproved, .changesRequested, .approved, .answer, .reopened, .failed]

    /// The look `kind` takes.
    public static func look(_ e: ActivityEntry) -> ActivityLook {
        switch e.kind {
        case .message: e.author == .human ? .mine : .plain
        case .answer: .reply
        case .blocked: .attention
        case .reviewApproved, .approved: .approved
        case .changesRequested: .changes
        case .failed, .system, .permission: .muted
        default: .plain
        }
    }

    /// The shared icon each kind shows (Icons.names).
    public static func icon(_ e: ActivityEntry) -> String {
        switch e.kind {
        case .note: "fileText"
        case .submitted: "send"
        case .blocked: "alert"
        case .unblocked: "play"
        case .reviewApproved: "checkCircle"
        case .changesRequested: "edit"
        case .approved: "check"
        case .message: "user"
        case .answer: "sparkle"
        case .reopened: "refresh"
        case .failed: "x"
        case .permission: "shield"
        case .system: "zap"
        case .unknown: e.author == .human ? "user" : e.author == .agent ? "sparkle" : "zap"
        }
    }

    /// The entry's heading.
    public static func title(_ e: ActivityEntry) -> String {
        switch e.kind {
        case .note: TicketDetailLogic.authorLabel(e.author)
        case .submitted: "Submitted for review"
        case .blocked: "Needs your answer"
        case .unblocked: "Picked back up"
        case .reviewApproved: by(e) == "conductor" ? "Conductor approved the review" : "Review approved"
        case .changesRequested: by(e) == "conductor" ? "Conductor requested changes" : "Changes requested"
        case .approved: by(e) == "conductor" ? "Approved by the conductor" : e.author == .human ? "You approved" : "Approved"
        case .message: TicketDetailLogic.authorLabel(e.author)
        case .answer: "Agent"
        case .reopened: "Re-opened"
        case .failed: "Run failed"
        case .permission: "Permission"
        case .system: "Harness"
        case .unknown: TicketDetailLogic.authorLabel(e.author)
        }
    }

    /// The small line after the title: a review's round and short commit ("Round 2 · 9f1c2ab"), a
    /// submit's spec revision ("at rev 4"); "" for the rest.
    public static func detail(_ e: ActivityEntry) -> String {
        switch e.kind {
        case .reviewApproved, .changesRequested:
            var parts: [String] = []
            if let round = e.meta.round { parts.append("Round \(round)") }
            if let commit = ChangesRows.short(e.meta.commit.optional), !commit.isEmpty { parts.append(commit) }
            return parts.joined(separator: " · ")
        case .submitted:
            return e.meta.specRevision.map { "at rev \($0)" } ?? ""
        default:
            return ""
        }
    }

    /// What a blocked card asks: meta.question, else the entry's body.
    public static func question(_ e: ActivityEntry) -> String {
        let q = JSCompat.trim(e.meta.question ?? "")
        return q.isEmpty ? e.body : q
    }

    /// The body under the title. A blocked card's question is its body, so the card doesn't
    /// repeat a body that only restates it.
    public static func body(_ e: ActivityEntry) -> String {
        if e.kind == .blocked {
            return JSCompat.trim(e.body) == JSCompat.trim(question(e)) ? "" : e.body
        }
        return e.body
    }

    /// Whether this is the newest blocked entry while the ticket is still blocked (its card stays
    /// loud; older ones were answered).
    public static func isOpenQuestion(_ e: ActivityEntry, in list: [ActivityEntry], ticket: Ticket) -> Bool {
        guard e.kind == .blocked, ticket.status == .blocked else { return false }
        return list.last { $0.kind == .blocked }?.id == e.id
    }

    private static func by(_ e: ActivityEntry) -> String? { e.meta.by }
}
