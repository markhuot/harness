import Foundation
import Testing
import HarnessKit

// Seen and unseen (DESIGN.md "Seen and unseen"): the card's marker, the menus' Mark ticket unseen,
// and when a focused detail marks its ticket seen.

private func ticket(_ status: TicketStatus, unseen: Bool? = nil, draft: Bool? = nil, compacting: Bool? = nil) -> Ticket {
    var t = Ticket(id: "t", key: "A-1", projectId: "p", title: "t", spec: "", status: status, sessionId: "s", driver: "d",
                   draft: draft, compacting: compacting, createdAt: 0, updatedAt: 0)
    t.unseen = unseen
    return t
}

private func entry(_ id: String, _ author: ActivityAuthor) -> ActivityEntry {
    ActivityEntry(id: id, sessionId: "s", author: author, body: "", createdAt: 0)
}

@Suite struct SeenTests {
    @Test func onlyUnseenCardsInBlockedAndReviewShowTheMarker() {
        #expect(BoardScreenRules.showsUnseen(ticket(.review, unseen: true)))
        #expect(BoardScreenRules.showsUnseen(ticket(.blocked, unseen: true)))
        for status in [TicketStatus.planning, .inProgress, .done] {
            #expect(!BoardScreenRules.showsUnseen(ticket(status, unseen: true)))
        }
        #expect(!BoardScreenRules.showsUnseen(ticket(.review, unseen: false)))
        #expect(!BoardScreenRules.showsUnseen(ticket(.review)))
    }

    @Test func markUnseenIsOfferedForASeenTicketInBlockedOrReviewOnly() {
        func offers(_ t: Ticket) -> Bool {
            TicketActions.set(for: t, project: nil, parent: nil, deps: [], settingsBaseBranch: nil).more.contains { $0.action == .markUnseen }
        }
        #expect(offers(ticket(.review)))
        #expect(offers(ticket(.blocked, unseen: false)))
        #expect(!offers(ticket(.review, unseen: true)))
        for status in [TicketStatus.planning, .inProgress, .done] { #expect(!offers(ticket(status))) }
    }

    @Test func theCardMenuOffersMarkUnseenWithTheOtherActionsAndNotWhileCompacting() {
        let menu = BoardScreenRules.cardMenu(ticket(.review), parent: nil)
        #expect(menu.contains(.ticket(.markUnseen)))
        #expect(menu.firstIndex(of: .ticket(.markUnseen))! < menu.firstIndex(of: .ticket(.delete))!)
        #expect(!BoardScreenRules.cardMenu(ticket(.review, unseen: true), parent: nil).contains(.ticket(.markUnseen)))
        #expect(!BoardScreenRules.cardMenu(ticket(.review, compacting: true), parent: nil).contains(.ticket(.markUnseen)))
    }

    @Test func focusMarksOnlyAnUnseenTicketSeen() {
        #expect(SeenRules.markOnFocus(focused: true, ticket: ticket(.review, unseen: true)))
        #expect(!SeenRules.markOnFocus(focused: false, ticket: ticket(.review, unseen: true)))
        #expect(!SeenRules.markOnFocus(focused: true, ticket: ticket(.review, unseen: false)))
        #expect(!SeenRules.markOnFocus(focused: true, ticket: nil))
    }

    @Test func newAgentOrSystemActivityWhileFocusedMarksItSeenAgain() {
        #expect(SeenRules.latestNonHuman([entry("a", .agent), entry("b", .system), entry("c", .human)]) == "b")
        #expect(SeenRules.latestNonHuman([entry("c", .human)]) == nil)
        #expect(SeenRules.markOnActivity(focused: true, previous: "a", latest: "b"))
        // The list loading for the first time isn't new activity, and neither is an unchanged one.
        #expect(!SeenRules.markOnActivity(focused: true, previous: nil, latest: "b"))
        #expect(!SeenRules.markOnActivity(focused: true, previous: "b", latest: "b"))
        #expect(!SeenRules.markOnActivity(focused: false, previous: "a", latest: "b"))
    }
}
