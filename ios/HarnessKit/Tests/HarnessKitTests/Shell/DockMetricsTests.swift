import Foundation
import Testing
@testable import HarnessKit

@Suite("Dock metrics")
struct DockMetricsTests {
    @Test func aStackIsItsCardsAndTheGapsBetween() {
        #expect(DockMetrics.stackHeight(rows: 0) == 0)
        #expect(DockMetrics.stackHeight(rows: 1) == CGFloat(64))
        #expect(DockMetrics.stackHeight(rows: 2) == CGFloat(136))
        #expect(DockMetrics.stackHeight(rows: 5) == CGFloat(352))
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
        // 16 + 16 of margin, then 64pt cards 8pt apart: one row needs 96, two need 168.
        #expect(DockMetrics.rowsFitting(height: 96) == 1)
        #expect(DockMetrics.rowsFitting(height: 167) == 1)
        #expect(DockMetrics.rowsFitting(height: 168) == 2)
        #expect(DockMetrics.rowsFitting(height: 10) == 1)
    }
}
