import CoreGraphics
import Testing
import HarnessKit

@Suite struct TicketPanelInsetTests {
    @Test func theStoredFractionIsOfTheSafeWidth() {
        // 1000 wide with a 60pt trailing inset: the person's 50% is of the 940 between the safe edges.
        let l = TicketPanelWidth.layout(totalWidth: 1000, inset: 60, stored: 0.5)
        #expect(l.window == 940)
        #expect(l.width == 470)
        // The frame reaches the screen's edge; what sits beside the panel is measured from the safe one.
        #expect(l.frameWidth == 530)
    }

    @Test func noInsetLaysOutAsBefore() {
        let l = TicketPanelWidth.layout(totalWidth: 1000, inset: 0, stored: nil)
        #expect(l.width == TicketPanelWidth.width(windowWidth: 1000, stored: nil))
        #expect(l.frameWidth == l.width)
    }

    @Test func aDraggedWidthWinsAndAnInsetNeverGoesNegative() {
        #expect(TicketPanelWidth.layout(totalWidth: 800, inset: 40, stored: 0.5, dragged: 300).width == 300)
        let bad = TicketPanelWidth.layout(totalWidth: 800, inset: -20, stored: 0.5)
        #expect(bad.inset == 0)
        #expect(bad.frameWidth == 400)
    }

    @Test func aDockedPanelLeavesNoSliverOfTheInset() {
        let l = TicketPanelWidth.layout(totalWidth: 1000, inset: 60, stored: 0.5)
        // The frame plus the shadow's reach: the inset is part of what has to leave.
        #expect(l.slideAway(shadowReach: 40) == 570)
    }

    // The Duo open in landscape: 678 x 466 with the inset on the trailing side.
    private let landscape = ConcentricBar.Screen(width: 678, height: 466, sideInsets: 40, homeIndicator: 21)

    @Test func theComposerFollowsTheBottomTrailingCorner() {
        let p = ConcentricBar.trailingCornerPadding(landscape, barHeight: 44)
        // 466 short side is the default 62 radius: 62 - 22 = 40 from the side, less the home indicator below.
        #expect(p == ConcentricBar.Padding(horizontal: 40, bottom: 19))
    }

    @Test func noCornerRuleInPortraitOrWithoutRoundedCorners() {
        let portrait = ConcentricBar.Screen(width: 402, height: 874, sideInsets: 0, homeIndicator: 34)
        #expect(ConcentricBar.trailingCornerPadding(portrait, barHeight: 44) == nil)
        let square = ConcentricBar.Screen(width: 678, height: 466, sideInsets: 40, homeIndicator: 0)
        #expect(ConcentricBar.trailingCornerPadding(square, barHeight: 44) == nil)
        #expect(ConcentricBar.trailingCornerPadding(nil, barHeight: 44) == nil)
    }
}
