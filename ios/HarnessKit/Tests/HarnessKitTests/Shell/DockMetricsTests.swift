import Foundation
import Testing
@testable import HarnessKit

@Suite("Dock metrics")
struct DockMetricsTests {
    @Test func aStackIsItsCardsAndTheGapsBetween() {
        #expect(DockMetrics.stackHeight(rows: 0) == 0)
        #expect(DockMetrics.stackHeight(rows: 1) == CGFloat(52))
        #expect(DockMetrics.stackHeight(rows: 2) == CGFloat(112))
        #expect(DockMetrics.stackHeight(rows: 5) == CGFloat(292))
    }

    @Test func dockedCardsShareTheBarsSides() {
        for (width, radius) in [(393, 55), (375, 39), (402, 62)] as [(CGFloat, CGFloat)] {
            let screen = ConcentricBar.Screen(width: width, height: 852, homeIndicator: 34)
            let bar = ConcentricBar.padding(screen, barHeight: 50)
            #expect(DockMetrics.phoneSides(screen: screen) == bar?.horizontal)
            #expect(DockMetrics.phoneSides(screen: screen) == radius - 25)
        }
    }

    @Test func dockedCardsFallBackToTheBarsConstantWithoutCorners() {
        #expect(DockMetrics.phoneSides(screen: nil) == 16)
        // Landscape and a Home-button phone have no concentric inset.
        #expect(DockMetrics.phoneSides(screen: .init(width: 852, height: 393, homeIndicator: 21)) == 16)
        #expect(DockMetrics.phoneSides(screen: .init(width: 375, height: 667, homeIndicator: 0)) == 16)
    }

    @Test func theOverflowCardCountsWhatItHides() {
        #expect(DockMetrics.moreLabel(count: 10, all: false) == "10 more docked tickets")
        #expect(DockMetrics.moreLabel(count: 12, all: true) == "12 docked tickets")
    }

    @Test func theCornerStackFitsTheColumnItIsGiven() {
        // Wide column: cards cap at 320 and sit 16pt in from the edge, so the room is width - 32.
        #expect(DockMetrics.cardMode(width: 800) == .cards(320))
        #expect(DockMetrics.cardMode(width: 352) == .cards(320))
        #expect(DockMetrics.cardMode(width: 300) == .cards(268))
        // 232 is the narrowest column with room for a 200pt card.
        #expect(DockMetrics.cardMode(width: 232) == .cards(200))
        #expect(DockMetrics.cardMode(width: 231) == .collapsed(199))
        // Below 150 there's no column to speak of.
        #expect(DockMetrics.cardMode(width: 150) == .collapsed(118))
        #expect(DockMetrics.cardMode(width: 149) == .hidden)
    }

    @Test func rowsFittingLeavesTheCornerMarginAboveAndBelow() {
        // 16 + 16 of margin, then 52pt cards 8pt apart: one row needs 84, two need 144.
        #expect(DockMetrics.rowsFitting(height: 84) == 1)
        #expect(DockMetrics.rowsFitting(height: 143) == 1)
        #expect(DockMetrics.rowsFitting(height: 144) == 2)
        #expect(DockMetrics.rowsFitting(height: 10) == 1)
    }
}
