import Testing
@testable import HarnessKit

/// Minimized cards: up to a platform's limit, then one "N more…" card.
@Suite("Dock cards")
struct DockCardsTests {
    @Test func upToTheLimitEveryTicketIsACard() {
        #expect(DockCards.split(count: 0, maxVisible: 2) == (0, 0))
        #expect(DockCards.split(count: 1, maxVisible: 2) == (1, 0))
        #expect(DockCards.split(count: 2, maxVisible: 2) == (2, 0))
        #expect(DockCards.split(count: 5, maxVisible: 5) == (5, 0))
    }

    @Test func pastTheLimitAMoreCardCountsTheRest() {
        // The iPhone's third row, the iPad's sixth.
        #expect(DockCards.split(count: 3, maxVisible: DockCards.phoneVisible) == (2, 1))
        #expect(DockCards.split(count: 7, maxVisible: DockCards.phoneVisible) == (2, 5))
        #expect(DockCards.split(count: 6, maxVisible: DockCards.padVisible) == (5, 1))
        #expect(DockCards.rows(count: 7, maxVisible: 2) == 3)
        #expect(DockCards.rows(count: 2, maxVisible: 2) == 2)
    }

    @Test func aShortSpaceFitsFewerCardsAndTheMoreCardTakesARow() {
        // Room for three rows: two cards and "N more…", not three cards and no way to the rest.
        #expect(DockCards.split(count: 5, maxVisible: 5, fitting: 3) == (2, 3))
        #expect(DockCards.split(count: 3, maxVisible: 5, fitting: 3) == (3, 0))
        #expect(DockCards.rows(count: 9, maxVisible: 5, fitting: 3) == 3)
        // One row: just "N more…", counting them all.
        #expect(DockCards.split(count: 4, maxVisible: 5, fitting: 1) == (0, 4))
        #expect(DockCards.split(count: 1, maxVisible: 5, fitting: 1) == (1, 0))
        // No card allowed (a column too narrow for one): "N more…" alone.
        #expect(DockCards.split(count: 3, maxVisible: 0) == (0, 3))
    }
}

/// What a docked card says, which the walkthrough's JOINS check used to find by label.
@Suite("Dock labels")
struct DockLabelsTests {
    @Test func aCardIsNamedByItsRefAndTitleThenDocked() {
        #expect(DockLabels.accessibilityLabel(ref: "WEB-2", title: "Fix the footer") == "WEB-2, Fix the footer, docked")
        #expect(DockLabels.accessibilityLabel(ref: "WEB-2", title: nil) == "WEB-2, docked")
        #expect(DockLabels.menuLine(ref: "WEB-2", title: "Fix the footer") == "WEB-2 · Fix the footer")
        #expect(DockLabels.menuLine(ref: "New session", title: nil) == "New session")
    }

    @Test func theDockHidesUnderAnythingOverTheTicket() {
        func shown(_ count: Int = 2, sheet: Bool = false, cover: Bool = false, keyboard: Bool = false, dialog: Bool = false) -> Bool {
            DockCards.isShown(count: count, sheetUp: sheet, coverUp: cover, keyboardUp: keyboard, dialogUp: dialog)
        }
        #expect(shown())
        #expect(!shown(0))
        #expect(!shown(sheet: true))
        #expect(!shown(cover: true))
        #expect(!shown(keyboard: true))
        #expect(!shown(dialog: true))
        #expect(!shown(1, keyboard: true, dialog: true))
        // The ghost card shows with nothing else docked, and under the same covers as the cards.
        #expect(DockCards.isShown(count: 0, ghost: true, sheetUp: false, coverUp: false, keyboardUp: false, dialogUp: false))
        #expect(!DockCards.isShown(count: 0, ghost: true, sheetUp: false, coverUp: false, keyboardUp: true, dialogUp: false))
    }

    @Test func anyPresentationAboveTheTicketSheetIsADialog() {
        // The ticket sheet itself (depth 1 of 1) and a bare board (0 of 0) are not.
        #expect(!DockCards.dialogUp(presentedDepth: 1, expected: 1))
        #expect(!DockCards.dialogUp(presentedDepth: 0, expected: 0))
        // A picker, popover or cover over the ticket sheet, or an alert over the board, is.
        #expect(DockCards.dialogUp(presentedDepth: 2, expected: 1))
        #expect(DockCards.dialogUp(presentedDepth: 1, expected: 0))
        // The ticket sheet not presented yet (it was just opened): nothing to hide for.
        #expect(!DockCards.dialogUp(presentedDepth: 0, expected: 1))
    }
}
