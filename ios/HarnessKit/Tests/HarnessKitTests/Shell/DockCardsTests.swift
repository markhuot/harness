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
