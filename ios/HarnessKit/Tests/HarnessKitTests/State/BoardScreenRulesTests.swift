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

    @Test func sideBySideSearchStaysWhileAnyVisibleColumnHasResults() {
        let cols = Columns(review: [Self.t("c", .review)], done: [Self.t("d", .done)])
        #expect(BoardScreenRules.columnWithResults(cols, visible: [.planning, .inProgress, .review]) == nil)
        #expect(BoardScreenRules.columnWithResults(cols, visible: [.planning, .inProgress, .blocked]) == .review)
        // Before any column reports itself on screen there's nothing to judge by.
        #expect(BoardScreenRules.columnWithResults(cols, visible: []) == nil)
        #expect(BoardScreenRules.columnWithResults(Columns(), visible: [.planning]) == nil)
    }

    // MARK: side-by-side columns

    @Test func columnsShareTheWidthWhenFiveFit() {
        // An 11-inch iPad in landscape: 1210 − 2×14 − 4×10 = 1142, so 228.4 each.
        let s = BoardScreenRules.columnSizing(available: 1210, spacing: 10, inset: 14)
        #expect(!s.scrolls)
        #expect(abs(s.width - 228.4) < 0.001)
    }

    @Test func columnsKeepTheMinimumAndScrollWhenTooNarrow() {
        // Portrait (834 wide) can't fit five at 216.
        #expect(BoardScreenRules.columnSizing(available: 834, spacing: 10, inset: 14) == .init(width: 216, scrolls: true))
        // Exactly the minimum still fits: 5×216 + 4×10 + 2×14.
        #expect(BoardScreenRules.columnSizing(available: 1148, spacing: 10, inset: 14) == .init(width: 216, scrolls: false))
        #expect(BoardScreenRules.columnSizing(available: 1147, spacing: 10, inset: 14).scrolls)
    }

    @Test func columnsStopGrowingAtTheMaximum() {
        #expect(BoardScreenRules.columnSizing(available: 3000, spacing: 10, inset: 14) == .init(width: 400, scrolls: false))
        #expect(BoardScreenRules.columnSizing(available: 0, count: 0, spacing: 10, inset: 14).scrolls == false)
    }

    @Test func doneAutofillsOnlyWhileOnScreenAndNotSearching() {
        func fill(_ layout: BoardScreenRules.Layout, page: TicketStatus? = nil, visible: Set<TicketStatus> = [], searching: Bool = false, count: Int = 3, canLoad: Bool = true) -> Bool {
            BoardScreenRules.shouldAutofillDone(layout, page: page, visible: visible, searching: searching, visibleCount: count, canLoad: canLoad)
        }
        // The pager goes by its page; what's "visible" doesn't count there.
        #expect(fill(.pager, page: .done))
        #expect(!fill(.pager, page: .review, visible: [.done]))
        // Side by side, Done only has to be partly on screen, whichever column leads.
        #expect(fill(.columns, page: .planning, visible: [.blocked, .review, .done]))
        #expect(!fill(.columns, page: .done, visible: [.planning, .inProgress]))
        #expect(!fill(.columns, visible: [.done], searching: true))
        #expect(!fill(.columns, visible: [.done], count: BoardLoader.autofillMin))
        #expect(!fill(.columns, visible: [.done], canLoad: false))
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

    // MARK: projects

    @Test func openCountsLeaveDoneOut() {
        let counts = BoardScreenRules.openCounts([Self.t("a"), Self.t("b", .done), Self.t("c", .blocked, project: "p2"), Self.t("d", .review)])
        #expect(counts == ["p1": 2, "p2": 1])
    }
}
