import Foundation

/// What the Spec tab shows above the spec for a blocked ticket, decided from the ticket alone:
/// its blockedReason, restart time and pending approval, so it needs neither the Activity feed
/// nor a loaded spec. Display-only: never part of the spec text. The Mac app keeps the same
/// rules in state/blockedCallout.ts.
public enum BlockedCallout: Equatable, Sendable {
    case none
    /// Waiting on the human's answer. `unblock` is whether the Unblock button applies (the header's gate).
    case question(String, unblock: Bool)
    /// A usage limit: restarts by itself at `at`; `reason` is the run's error.
    case restart(at: Timestamp, reason: String)
    /// A tool waits on an allow or deny.
    case approval(PendingApproval)

    public static func of(_ ticket: Ticket) -> BlockedCallout {
        guard ticket.status == .blocked, ticket.draft != true else { return .none }
        let reason = (ticket.blockedReason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let approval = ticket.pendingApproval { return .approval(approval) }
        if let at = Conductor.restartsAt(ticket) { return .restart(at: at, reason: reason) }
        return .question(reason, unblock: TicketActions.canUnblock(ticket))
    }
}
