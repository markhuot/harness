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
}
