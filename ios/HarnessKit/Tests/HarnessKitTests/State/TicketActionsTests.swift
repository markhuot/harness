import Foundation
import Testing
@testable import HarnessKit

@Suite("Ticket actions")
struct TicketActionsTests {
    static func t(_ status: TicketStatus, busy: Bool = false, compacting: Bool? = nil, humanReview: ReviewState = .pending,
                  agentReview: ReviewState = .pending, parentId: String? = nil, draft: Bool? = nil, startAfterPlan: Bool? = nil,
                  autoStart: Bool = false) -> Ticket {
        Ticket(id: "t1", key: "K-1", projectId: "p1", title: "Hi", spec: "", status: status, sessionId: "s1", driver: "dummy",
               parentId: parentId, dependsOn: autoStart ? ["K-9"] : [], autoStart: autoStart, startAfterPlan: startAfterPlan,
               agentReview: agentReview, humanReview: humanReview, draft: draft, busy: busy, compacting: compacting,
               createdAt: 1, updatedAt: 1)
    }

    static func titles(_ t: Ticket, parent: Ticket? = nil, deps: [DepState] = []) -> [String] {
        TicketActions.set(for: t, project: nil, parent: parent, deps: deps, settingsBaseBranch: nil).enabledActions.map(\.title)
    }

    @Test func planningOffersStartWork() {
        #expect(Self.titles(Self.t(.planning)) == ["Start work", "Move to done", "Delete ticket"])
    }

    @Test func aPlanningRunOffersApprovePlanAndCancel() {
        #expect(Self.titles(Self.t(.planning, busy: true)) == ["Approve plan", "Move to done", "Cancel run", "Delete ticket"])
    }

    @Test func anApprovedPlanAndAWaitingTicketOfferNoStart() {
        #expect(Self.titles(Self.t(.planning, busy: true, startAfterPlan: true)) == ["Move to done", "Cancel run", "Delete ticket"])
        let waiting = [DepState(key: "K-9", done: false, state: .pending)]
        #expect(Self.titles(Self.t(.planning, autoStart: true), deps: waiting) == ["Move to done", "Delete ticket"])
        // Its dependencies done, Start is back.
        #expect(Self.titles(Self.t(.planning, autoStart: true), deps: [DepState(key: "K-9", done: true, state: .done)]).first == "Start work")
    }

    @Test func inProgressOffersNoStatusActionButMoreItems() {
        #expect(Self.titles(Self.t(.inProgress, busy: true)) == ["Move to done", "Cancel run", "Delete ticket"])
        #expect(Self.titles(Self.t(.inProgress)) == ["Move to done", "Delete ticket"])
    }

    @Test func reviewOffersApproveRequestChangesAndAgentReview() {
        #expect(Self.titles(Self.t(.review)) == ["Approve and clean up", "Request changes", "Re-run agent review", "Delete ticket"])
        #expect(Self.titles(Self.t(.review, agentReview: .skipped)).contains("Run agent review"))
    }

    @Test func approvedReviewOffersNoApproveOrRequestChanges() {
        #expect(Self.titles(Self.t(.review, humanReview: .approved)) == ["Re-run agent review", "Delete ticket"])
    }

    @Test func aConductorManagedReviewHasApproveOffButKeepsTheRest() {
        let parent = Self.t(.inProgress)
        let child = Self.t(.review, parentId: "t0")
        let set = TicketActions.set(for: child, project: nil, parent: parent, deps: [], settingsBaseBranch: nil)
        let approve = set.primary.first
        #expect(approve?.enabled == false)
        guard case let .approve(_, _, _, reason)? = approve?.action else { Issue.record("no Approve")
            return }
        #expect(reason == "Conductor managed: K-1 approves and lands this ticket")
        #expect(Self.titles(child, parent: parent) == ["Request changes", "Re-run agent review", "Delete ticket"])
        // Once the conductor is done, the human takes it back.
        #expect(Self.titles(child, parent: Self.t(.done)).first == "Approve and clean up")
    }

    @Test func approveCarriesTheWaysToApprove() {
        guard case let .approve(_, primary, choices, _)? = TicketActions.set(for: Self.t(.review), project: nil, parent: nil, deps: [], settingsBaseBranch: nil).primary.first?.action else {
            Issue.record("no Approve")
            return
        }
        #expect(choices.last?.value == Approve.Choice.none)
        if case let .review(body) = primary { #expect(body.decision == .approve) } else { Issue.record("expected a review request") }
    }

    @Test func doneOffersReopen() {
        #expect(Self.titles(Self.t(.done)) == ["Re-open", "Delete ticket"])
    }

    @Test func aBusyReviewDisablesAgentReviewAndCompactingDisablesAllButCancel() {
        let busy = TicketActions.set(for: Self.t(.review, busy: true), project: nil, parent: nil, deps: [], settingsBaseBranch: nil)
        #expect(busy.more.first == TicketActionItem(.rerunAgentReview(title: "Re-run agent review"), enabled: false))
        let compacting = TicketActions.set(for: Self.t(.inProgress, busy: true, compacting: true), project: nil, parent: nil, deps: [], settingsBaseBranch: nil)
        #expect(compacting.enabledActions == [.cancelRun])
        #expect(Self.titles(Self.t(.planning, compacting: true)) == [])
    }

    @Test func aDraftOffersNothing() {
        #expect(Self.titles(Self.t(.planning, draft: true)).isEmpty)
    }

    @Test func destructiveItemsAreCancelAndDelete() {
        #expect(TicketAction.cancelRun.isDestructive && TicketAction.delete.isDestructive)
        #expect(!TicketAction.moveToDone.isDestructive && !TicketAction.reopen.isDestructive)
    }
}
