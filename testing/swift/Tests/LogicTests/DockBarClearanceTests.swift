import CoreGraphics
import Testing
import HarnessKit

@Suite struct DockBarClearanceTests {
    @Test func cardsLiftByTheBarAboveTheHomeIndicator() {
        // The system bar reaches 83pt up, 34 of it the home indicator: 49pt of bar to clear.
        #expect(DockMetrics.lift(barInset: 83, homeIndicator: 34) == 49)
    }

    @Test func noBarMeansNoLift() {
        #expect(DockMetrics.lift(barInset: 0, homeIndicator: 34) == 0)
        // A bar no taller than the indicator (not yet measured) never pushes the cards down.
        #expect(DockMetrics.lift(barInset: 20, homeIndicator: 34) == 0)
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
