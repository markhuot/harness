import Foundation
import Testing
@testable import HarnessKit

/// The iPad side panel's width: 800pt by default, then the person's fraction of the window, always
/// between 25% and 80% of it.
@Suite("TicketPanelWidth")
struct TicketPanelWidthTests {
    @Test func defaultIsEightHundredPointsWhenTheWindowAllowsIt() {
        #expect(TicketPanelWidth.width(windowWidth: 1366, stored: nil) == 800)
        // Exactly at the 80% boundary: 800 / 1000.
        #expect(TicketPanelWidth.width(windowWidth: 1000, stored: nil) == 800)
    }

    @Test func defaultShrinksToEightyPercentOnASmallWindow() {
        // A slide-over-sized or split window where 800pt would cover it.
        #expect(TicketPanelWidth.width(windowWidth: 700, stored: nil) == 560)
        #expect(TicketPanelWidth.defaultFraction(windowWidth: 999) == 0.80)
    }

    @Test func defaultGrowsToAQuarterOnAVeryWideWindow() {
        // 800 / 4000 = 20%, under the minimum.
        #expect(TicketPanelWidth.width(windowWidth: 4000, stored: nil) == 1000)
    }

    @Test func storedFractionIsClampedAtBothEnds() {
        #expect(TicketPanelWidth.width(windowWidth: 1200, stored: 0.25) == 300)
        #expect(TicketPanelWidth.width(windowWidth: 1200, stored: 0.24) == 300)
        #expect(TicketPanelWidth.width(windowWidth: 1200, stored: 0.80) == 960)
        #expect(TicketPanelWidth.width(windowWidth: 1200, stored: 0.95) == 960)
        #expect(TicketPanelWidth.width(windowWidth: 1200, stored: 0.5) == 600)
    }

    @Test func storedFractionWinsOverTheDefault() {
        // The default would be 800 / 1366; the person's 40% is kept instead.
        #expect(TicketPanelWidth.fraction(windowWidth: 1366, stored: 0.4) == 0.4)
    }

    @Test func rotationKeepsTheFractionAndRescalesTheWidth() {
        let stored = TicketPanelWidth.fraction(forWidth: 683, windowWidth: 1366)
        #expect(stored == 0.5)
        // Landscape to portrait: the same half, in points of the narrower window.
        #expect(TicketPanelWidth.width(windowWidth: 1024, stored: stored) == 512)
        #expect(TicketPanelWidth.width(windowWidth: 1366, stored: stored) == 683)
    }

    @Test func defaultWidthRecomputesWhenTheWindowShrinks() {
        // No stored fraction: 800pt in landscape, 80% once a split view narrows the window.
        #expect(TicketPanelWidth.width(windowWidth: 1366, stored: nil) == 800)
        #expect(TicketPanelWidth.width(windowWidth: 800, stored: nil) == 640)
    }

    @Test func draggedWidthClampsToTheRange() {
        #expect(TicketPanelWidth.fraction(forWidth: 100, windowWidth: 1000) == 0.25)
        #expect(TicketPanelWidth.fraction(forWidth: 900, windowWidth: 1000) == 0.80)
        #expect(TicketPanelWidth.fraction(forWidth: 600, windowWidth: 1000) == 0.6)
        #expect(TicketPanelWidth.clampedWidth(-50, windowWidth: 1000) == 250)
        #expect(TicketPanelWidth.clampedWidth(2000, windowWidth: 1000) == 800)
    }

    @Test func degenerateInputsDoNotDivideByZero() {
        #expect(TicketPanelWidth.width(windowWidth: 0, stored: nil) == 0)
        #expect(TicketPanelWidth.fraction(forWidth: 300, windowWidth: 0) == 0.80)
        #expect(TicketPanelWidth.fraction(windowWidth: 1366, stored: .nan) == 800.0 / 1366)
        #expect(TicketPanelWidth.clamp(.infinity) == 0.80)
    }
}
