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

    @Test func clearanceReachesTheTopOfTheWholeStack() {
        // 852pt screen, 34pt home indicator, cards float 8pt up: the stack's top is 852 - 8 - stackHeight.
        for rows in 1...3 {
            let top = 852 - 8 - DockMetrics.stackHeight(rows: rows)
            let clearance = DockMetrics.clearance(screenHeight: 852, stackTop: top, homeIndicator: 34, rows: rows)
            #expect(clearance == DockMetrics.stackHeight(rows: rows) + 8 - 34)
        }
        // A taller stack always asks for more room, so the bar never ends up under the top card.
        let one = DockMetrics.clearance(screenHeight: 852, stackTop: 852 - 8 - 52, homeIndicator: 34, rows: 1)
        let three = DockMetrics.clearance(screenHeight: 852, stackTop: 852 - 8 - 172, homeIndicator: 34, rows: 3)
        #expect(three - one == 120)
    }

    @Test func clearanceBeforeMeasuringGrowsWithTheRows() {
        let one = DockMetrics.clearance(screenHeight: nil, stackTop: nil, homeIndicator: 34, rows: 1)
        let two = DockMetrics.clearance(screenHeight: nil, stackTop: nil, homeIndicator: 34, rows: 2)
        #expect(two - one == 60)
        #expect(DockMetrics.clearance(screenHeight: nil, stackTop: nil, homeIndicator: 34, rows: 0) == one)
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
