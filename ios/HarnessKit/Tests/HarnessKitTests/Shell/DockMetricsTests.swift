import Foundation
import Testing
@testable import HarnessKit

@Suite("Dock metrics")
struct DockMetricsTests {
    @Test func theBarSitsElevenPointsAboveTheDock() {
        #expect(DockMetrics.barGap == 11)
    }

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
}
