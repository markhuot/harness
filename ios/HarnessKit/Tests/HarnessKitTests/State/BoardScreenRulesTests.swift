import Foundation
import Testing
@testable import HarnessKit

@Suite("Board screen rules (board, ticket cards, projects)")
struct BoardScreenRulesTests {
    static func t(_ id: String, _ status: TicketStatus = .planning, position: Double = 0, project: String = "p1", parentId: String? = nil,
                  draft: Bool? = nil, title: String = "Title", description: String = "", completedAt: Patch<Timestamp> = .absent) -> Ticket {
        Ticket(id: id, key: "K-\(id)", projectId: project, title: title, description: description, status: status, sessionId: "s\(id)", driver: "dummy",
               parentId: parentId, draft: draft, position: position, completedAt: completedAt, createdAt: 1, updatedAt: 1)
    }

    // MARK: landing / search jump

    @Test func landingPrefersWhatNeedsYouThenWhatsMoving() {
        var cols = Columns(planning: [Self.t("a")], inProgress: [Self.t("b", .inProgress)], review: [Self.t("c", .review)])
        #expect(BoardScreenRules.landingColumn(cols) == .review)
        cols.blocked = [Self.t("d", .blocked)]
        #expect(BoardScreenRules.landingColumn(cols) == .blocked)
        cols = Columns(planning: [Self.t("a")], inProgress: [Self.t("b", .inProgress)])
        #expect(BoardScreenRules.landingColumn(cols) == .inProgress)
    }

    @Test func landingNeverPicksDoneAndIsNilWhenNothingIsLive() {
        #expect(BoardScreenRules.landingColumn(Columns(done: [Self.t("a", .done)])) == nil)
        #expect(BoardScreenRules.landingColumn(Columns()) == nil)
    }

    @Test func searchJumpsOnlyWhenTheCurrentColumnIsEmpty() {
        let cols = Columns(review: [Self.t("c", .review)], done: [Self.t("d", .done)])
        #expect(BoardScreenRules.columnWithResults(cols, current: .review) == nil)
        #expect(BoardScreenRules.columnWithResults(cols, current: .planning) == .review)
        #expect(BoardScreenRules.columnWithResults(Columns(), current: .planning) == nil)
    }

    // MARK: card menu, labels, title

    @Test func draftMenuDiscardsInsteadOfMoving() {
        let d = Self.t("a", draft: true)
        #expect(BoardScreenRules.cardMenu(d, parent: nil) == [.discardDraft, .copyKey])
        #expect(BoardScreenRules.accessibilityMoves(d).isEmpty)
    }

    @Test func menuOffersOtherColumnsReorderAndParent() {
        let parent = Self.t("p", .inProgress)
        let menu = BoardScreenRules.cardMenu(Self.t("a", .review, parentId: "p"), parent: parent)
        #expect(menu == [.move(.planning), .move(.inProgress), .move(.blocked), .move(.done), .moveTo(.top), .moveTo(.bottom), .openParent(key: "K-p"), .copyKey])
    }

    @Test func doneCardsCantBeReordered() {
        let menu = BoardScreenRules.cardMenu(Self.t("a", .done), parent: nil)
        #expect(!menu.contains(.moveTo(.top)) && !menu.contains(.moveTo(.bottom)))
        #expect(!menu.contains(.move(.done)))
        #expect(BoardScreenRules.accessibilityMoves(Self.t("a", .done)) == [.planning, .inProgress, .blocked, .review])
    }

    @Test func menuTitleNamesTheCardAndCutsAt90() {
        #expect(BoardScreenRules.menuTitle(Self.t("1", .review)) == "K-1 · Title")
        // A draft says so instead of its title, however long that is.
        #expect(BoardScreenRules.menuTitle(Self.t("1", draft: true, title: String(repeating: "x", count: 200))) == "K-1 · Draft")
        // 90 characters, key included: "K-1 · " is 6, so 84 of the title survive.
        let long = BoardScreenRules.menuTitle(Self.t("1", title: String(repeating: "a", count: 84) + "bcd"))
        #expect(long.count == 90)
        #expect(long == "K-1 · " + String(repeating: "a", count: 84))
        #expect(BoardScreenRules.menuTitle(Self.t("1", title: String(repeating: "a", count: 84))).count == 90)
    }

    @Test func accessibilityLabelSaysWhyACardMatters() {
        #expect(BoardScreenRules.cardAccessibilityLabel(Self.t("1", draft: true, title: "")) == "K-1 , draft")
        #expect(BoardScreenRules.cardAccessibilityLabel(Self.t("1", .blocked)) == "K-1 Title, blocked")
        var waiting = Self.t("1", .blocked)
        waiting.pendingApproval = PendingApproval(id: "a", runId: "r", toolName: "Bash", input: .null, requestedAt: 1)
        #expect(BoardScreenRules.cardAccessibilityLabel(waiting) == "K-1 Title, needs approval")
        #expect(BoardScreenRules.cardAccessibilityLabel(Self.t("1", .review)) == "K-1 Title")
    }

    @Test func draftTitleFallsBackToTheFirstLine() {
        #expect(BoardScreenRules.cardTitle(Self.t("1", draft: true, title: "", description: "Fix it\nmore")) == "Fix it")
        #expect(BoardScreenRules.cardTitle(Self.t("1", draft: true, title: "", description: "\nsecond")) == "Empty draft")
        #expect(BoardScreenRules.cardTitle(Self.t("1", draft: true, title: "", description: "a\r\nb")) == "a\r")
        #expect(BoardScreenRules.cardTitle(Self.t("1", title: "", description: "words")) == "Untitled")
    }

    // MARK: drag and drop

    @Test func dropBetweenTwoCardsTakesTheMidpoint() throws {
        let a = Self.t("a", position: 1), b = Self.t("b", position: 2), c = Self.t("c", position: 3)
        let cols = Columns(planning: [a, b, c])
        // c dropped above b: between a (1) and b (2).
        let m = try #require(BoardScreenRules.dropMove(c, to: .planning, before: "b", cols: cols))
        #expect(m.body == .init(status: nil, position: 1.5))
        // a dropped at the end: after c.
        #expect(BoardScreenRules.dropMove(a, to: .planning, before: nil, cols: cols)?.body.position == 4)
    }

    @Test func dropWhereItAlreadyIsChangesNothing() {
        let a = Self.t("a", position: 1), b = Self.t("b", position: 2), c = Self.t("c", position: 3)
        let cols = Columns(planning: [a, b, c])
        #expect(BoardScreenRules.dropMove(b, to: .planning, before: "b", cols: cols) == nil)
        #expect(BoardScreenRules.dropMove(a, to: .planning, before: "b", cols: cols) == nil) // a is already above b
        #expect(BoardScreenRules.dropMove(c, to: .planning, before: nil, cols: cols) == nil)
        // One step down is a real move.
        #expect(BoardScreenRules.dropMove(a, to: .planning, before: "c", cols: cols)?.body.position == 2.5)
    }

    @Test func dropCountsHiddenCardsSoTheyKeepTheirPlace() {
        // A hidden child at position 2 sits between the two visible cards; dropping above b lands
        // between the child and b, not between a and b.
        let a = Self.t("a", position: 1), kid = Self.t("k", position: 2, parentId: "x"), b = Self.t("b", position: 3)
        let moving = Self.t("m", .review)
        let m = BoardScreenRules.dropMove(moving, to: .planning, before: "b", cols: Columns(planning: [a, kid, b]))
        #expect(m?.body == .init(status: .planning, position: 2.5))
        #expect(m?.completedAt == .null)
    }

    @Test func dropIntoDoneSendsNoPositionAndCompletesNow() {
        let t = Self.t("a", .review)
        let m = BoardScreenRules.dropMove(t, to: .done, before: "z", cols: Columns(done: [Self.t("z", .done)]), now: 42)
        #expect(m?.body == .init(status: .done, position: nil))
        #expect(m?.completedAt == .value(42))
        // Reordering within Done is a no-op.
        let d = Self.t("d", .done, completedAt: .value(5))
        #expect(BoardScreenRules.dropMove(d, to: .done, before: nil, cols: Columns(done: [d])) == nil)
    }

    @Test func dropOnAnUnknownCardGoesToTheEnd() {
        let a = Self.t("a", position: 1)
        let m = BoardScreenRules.dropMove(Self.t("m", .review), to: .planning, before: "gone", cols: Columns(planning: [a]))
        #expect(m?.body.position == 2)
    }

    // MARK: projects

    @Test func openCountsLeaveDoneOut() {
        let counts = BoardScreenRules.openCounts([Self.t("a"), Self.t("b", .done), Self.t("c", .blocked, project: "p2"), Self.t("d", .review)])
        #expect(counts == ["p1": 2, "p2": 1])
    }
}
