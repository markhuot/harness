import CoreGraphics
import Testing
import HarnessKit

@Suite struct DockBarClearanceTests {
    // iPhone 17 Pro: 402 x 874, home indicator 34, the bar reaching 83 up.
    private let phone = ConcentricBar.Screen(width: 402, height: 874, sideInsets: 0, homeIndicator: 34)
    private func button(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(x: x, y: y, width: 48, height: 48) }

    @Test func cardsTakeTheBarsWidthAndFloatAboveIt() {
        let bar = DockBar.bar(items: [button(20, 790), button(334, 790), button(334, 790)], inset: 83)
        let p = DockMetrics.phonePlacement(bar: bar, screen: phone)
        #expect(p.leading == 20)
        #expect(p.trailing == CGFloat(402 - 382))
        // The bar's 49pt above the home indicator, and the gap over it.
        #expect(p.bottom == CGFloat(8 + 49))
    }

    @Test func aButtonLiftedOutOfTheRowSharesTheCardsRow() {
        // The Duo stacks search above New session in its right margin; Projects is bottom left.
        let sidebar = button(20, 606), search = button(394, 546), compose = button(394, 606)
        let duo = ConcentricBar.Screen(width: 466, height: 678, sideInsets: 0, homeIndicator: 0)
        let bar = DockBar.bar(items: [sidebar, search, compose], inset: 72)
        #expect(bar?.raised == search)
        let p = DockMetrics.phonePlacement(bar: bar, screen: duo)
        #expect(p.leading == 20)
        // Ends short of the lifted button.
        #expect(p.trailing == 466 - 394 + DockMetrics.barSideGap)
        // The card's center is the button's: 570 down, 26 either side.
        #expect(p.bottom == CGFloat(678 - (570 + 26)))
    }

    @Test func buttonsInOneRowAreNotLifted() {
        // A few points apart (a badge, a tinted button) is still one row.
        let bar = DockBar.bar(items: [button(20, 790), button(334, 786)], inset: 83)
        #expect(bar?.raised == nil)
    }

    @Test func beforeTheBarIsMeasuredTheScreensCornersDecideTheSides() {
        #expect(DockBar.bar(items: [], inset: 83) == nil)
        let p = DockMetrics.phonePlacement(bar: nil, screen: phone)
        // Above where the bar will be (3 padding + 50 tall on this phone), so a ticket opened over an
        // unmeasured board doesn't put the cards on the composer.
        #expect(p.bottom == DockMetrics.phoneBottomGap + 53)
        #expect(DockMetrics.phonePlacement(bar: nil, screen: nil).bottom == DockMetrics.phoneBottomGap)
        #expect(p.leading == p.trailing)
        #expect(p.leading == DockMetrics.phoneSides(screen: phone))
    }

    @Test func anEmptyReadingKeepsTheLastBarAndARealOneReplacesIt() {
        let first = DockBar.bar(items: [button(20, 790), button(334, 790)], inset: 83)
        #expect(DockBar.holding(first, items: [], inset: 83) == first)
        #expect(DockBar.holding(nil, items: [], inset: 83) == nil)
        let moved = DockBar.holding(first, items: [button(30, 790), button(324, 790)], inset: 60)
        #expect(moved != first)
        #expect(moved?.inset == 60)
    }

    @Test func theComposerAndTheBoardBarShareTheirSides() {
        // The composer pads itself with the bar height the dock takes its sides from.
        #expect(ConcentricBar.padding(phone, barHeight: DockMetrics.barHeight)?.horizontal == DockMetrics.phoneSides(screen: phone))
    }

    @Test func theBoardKeepsRoomFromTheStackTopToTheBar() {
        // 874pt screen, bar's top 83 up, stack (one card, 8 over the bar) top at 874 - 83 - 8 - 52.
        let top: CGFloat = 874 - 83 - 8 - 52
        #expect(DockMetrics.boardClearance(screenHeight: 874, stackTop: top, barInset: 83, rows: 1) == 60)
    }

    @Test func aStaleMeasurementNeverLeavesLessThanTheCardsNeed() {
        // The stack's top at the screen's bottom edge: the floor is rows of cards and the gap.
        #expect(DockMetrics.boardClearance(screenHeight: 874, stackTop: 874, barInset: 83, rows: 2) == 120)
    }

    @Test func beforeTheStackIsMeasuredItIsTheFloor() {
        #expect(DockMetrics.boardClearance(screenHeight: nil, stackTop: nil, barInset: 83, rows: 1) == 60)
        // No cards counted still reserves one row.
        #expect(DockMetrics.boardClearance(screenHeight: nil, stackTop: nil, barInset: 83, rows: 0) == 60)
    }

    @Test func theIPadsCardsRiseAboveTheBarBeyondWhatTheHostKeepsClear() {
        // The bar reaches 70 up; the host already keeps 20 clear.
        #expect(DockMetrics.padBottomMargin(barInset: 70, safeArea: 20) == DockMetrics.cornerMargin + 50)
        #expect(DockMetrics.padBottomMargin(barInset: 0, safeArea: 20) == DockMetrics.cornerMargin)
        #expect(DockMetrics.padBottomMargin(barInset: 10, safeArea: 20) == DockMetrics.cornerMargin)
    }

    @Test func aHigherBottomMarginFitsFewerPadRows() {
        let flat = DockMetrics.rowsFitting(height: 400)
        let lifted = DockMetrics.rowsFitting(height: 400, bottom: DockMetrics.cornerMargin + 120)
        #expect(lifted < flat)
    }
}
