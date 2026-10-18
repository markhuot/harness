import Foundation
import Testing
import HarnessKit

private func ticket(_ status: TicketStatus, agent: ReviewState = .pending, human: ReviewState = .pending, resumeAt: Timestamp? = nil,
                    pending: PendingApproval? = nil, busy: Bool = false, compacting: Bool? = nil, completing: Bool? = nil, draft: Bool? = nil) -> Ticket {
    Ticket(id: "t", key: "A-1", projectId: "p", title: "t", spec: "", status: status, sessionId: "s", driver: "d", agentReview: agent, humanReview: human,
           draft: draft, resumeAt: resumeAt.map { .value($0) } ?? .absent, busy: busy, compacting: compacting, completing: completing,
           pendingApproval: pending, createdAt: 0, updatedAt: 0)
}

private func primary(_ t: Ticket) -> [TicketAction] {
    TicketActions.set(for: t, project: nil, parent: nil, deps: [], settingsBaseBranch: nil).primary.map(\.action)
}

@Suite struct TicketActionsTests {
    @Test func aBlockedTicketWaitingOnTheHumanOffersUnblock() {
        #expect(primary(ticket(.blocked)) == [.unblock])
    }

    @Test func aRestartTimeARunOrAToolApprovalHidesUnblock() {
        #expect(primary(ticket(.blocked, resumeAt: 123)).isEmpty)
        #expect(primary(ticket(.blocked, busy: true)).isEmpty)
        let approval = PendingApproval(id: "a", runId: "r", toolName: "Bash", input: .null, requestedAt: 0)
        #expect(primary(ticket(.blocked, pending: approval)).isEmpty)
    }

    @Test func compactingTurnsUnblockOff() {
        let set = TicketActions.set(for: ticket(.blocked, compacting: true), project: nil, parent: nil, deps: [], settingsBaseBranch: nil)
        #expect(set.primary == [TicketActionItem(.unblock, enabled: false)])
    }

    @Test func approvedStandInsFollowTheTable() {
        #expect(Conductor.approvedStandIn(ticket(.review, human: .approved, busy: true)) == .agentReview)
        #expect(Conductor.approvedStandIn(ticket(.review, human: .approved, busy: true, completing: true)) == .completing)
        #expect(Conductor.approvedStandIn(ticket(.review, agent: .approved, human: .approved)) == .completing)
        #expect(Conductor.approvedStandIn(ticket(.review, agent: .skipped, human: .approved)) == .completing)
        #expect(Conductor.approvedStandIn(ticket(.review, agent: .changesRequested, human: .approved)) == .agentReviewNeeded)
        #expect(Conductor.approvedStandIn(ticket(.review, human: .pending)) == nil)
        #expect(Conductor.approvedStandIn(ticket(.inProgress, human: .approved)) == nil)
        #expect(Conductor.approvedStandIn(ticket(.review, human: .approved), managed: true) == nil)
    }
}
