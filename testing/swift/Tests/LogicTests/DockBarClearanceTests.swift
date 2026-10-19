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
        #expect(p.bottom == DockMetrics.phoneBottomGap)
        #expect(p.leading == p.trailing)
        #expect(p.leading == DockMetrics.phoneSides(screen: phone))
    }

    @Test func aComposerRowIsABarOverTheScreensBottom() {
        // The row's top 120 up from the bottom of an 874pt screen, 12 in from each side.
        let bar = DockBar.above(row: CGRect(x: 12, y: 754, width: 378, height: 44), screenHeight: 874)
        #expect(bar.inset == 120)
        let p = DockMetrics.phonePlacement(bar: bar, screen: phone)
        #expect(p.leading == 12)
        #expect(p.trailing == 12)
        #expect(p.bottom == CGFloat(8 + (120 - 34)))
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
}
