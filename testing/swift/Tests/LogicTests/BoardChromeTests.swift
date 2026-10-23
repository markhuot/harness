import Testing
import HarnessKit

@Suite struct BoardChromeTests {
    @Test func aLandscapePhoneShowsColumnsSideBySideLikeTheIPad() {
        #expect(BoardScreenRules.layout(regularWidth: false, compactHeight: true) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: true, compactHeight: true) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: true, compactHeight: false) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: false, compactHeight: false) == .pager)
    }

    @Test func theRailReplacesTheStripOnlyWhereThereIsAMarginAndOnlyForThePager() {
        #expect(BoardScreenRules.tabs(layout: .pager, trailingMargin: 0) == .topStrip)
        #expect(BoardScreenRules.tabs(layout: .pager, trailingMargin: BoardScreenRules.railMinMargin - 1) == .topStrip)
        #expect(BoardScreenRules.tabs(layout: .pager, trailingMargin: BoardScreenRules.railMinMargin) == .rail)
        #expect(BoardScreenRules.tabs(layout: .columns, trailingMargin: 200) == .none)
        #expect(BoardScreenRules.tabs(layout: .columns, trailingMargin: 0) == .none)
    }

    @Test func theRailShowsCountsOnlyWithRoomAndCapsThem() {
        #expect(!BoardScreenRules.railShowsCounts(trailingMargin: BoardScreenRules.railCountsMinMargin - 1))
        #expect(BoardScreenRules.railShowsCounts(trailingMargin: BoardScreenRules.railCountsMinMargin))
        #expect(BoardScreenRules.railCountLabel(99) == "99")
        #expect(BoardScreenRules.railCountLabel(100) == "99+")
    }

    @Test func theRailShrinksItsTabsAndDropsCountsBeforeItRunsUnderTheButtons() {
        // Five tabs: 5 × height + 8 padding + 8 spacing.
        func tab(_ h: Double, counts: Bool = true) -> (height: Double, counts: Bool) {
            BoardScreenRules.railTab(availableHeight: h, wantsCounts: counts, tabCount: 5)
        }
        #expect(tab(246).height == 46 && tab(246).counts)
        #expect(tab(245).height == 38 && !tab(245).counts)
        #expect(tab(246, counts: false).height == 38)
        #expect(tab(200).height == 32 && !tab(200).counts)
        #expect(tab(10).height == 26)
    }
}
