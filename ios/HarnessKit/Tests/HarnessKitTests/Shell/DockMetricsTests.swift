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

    // MARK: With a keyboard up (the composer sits on the keyboard, the dock steps aside)

    @Test func theSheetKeepsRoomForTheDockOnlyWithCardsAndNoKeyboard() {
        let top = 852 - 8 - DockMetrics.stackHeight(rows: 2)
        let room = DockMetrics.sheetRoom(cards: 2, keyboardUp: false, screenHeight: 852, stackTop: top)
        // The whole two-card stack plus its float above the bottom edge (no home-indicator inset to subtract in the sheet).
        #expect(room == DockMetrics.stackHeight(rows: 2) + 8)
        // A keyboard up hides the dock, so the sheet keeps nothing: the composer sits on the keyboard.
        #expect(DockMetrics.sheetRoom(cards: 2, keyboardUp: true, screenHeight: 852, stackTop: top) == 0)
        // No cards waiting, no room, keyboard or not.
        #expect(DockMetrics.sheetRoom(cards: 0, keyboardUp: false, screenHeight: 852, stackTop: top) == 0)
        #expect(DockMetrics.sheetRoom(cards: 0, keyboardUp: true, screenHeight: 852, stackTop: top) == 0)
    }

    @Test func theSheetsRoomCountsTheRowsTheDockDrawsAndNeverGoesNegative() {
        // Not yet measured: it grows with the rows, and a third ticket adds the "N more…" row, not a card.
        func unmeasured(_ cards: Int) -> CGFloat { DockMetrics.sheetRoom(cards: cards, keyboardUp: false, screenHeight: nil, stackTop: nil) }
        #expect(unmeasured(2) - unmeasured(1) == 60)
        #expect(unmeasured(3) - unmeasured(2) == 60)
        #expect(unmeasured(7) == unmeasured(3))
        // A stack top measured below the screen's bottom (a stale reading) never gives a negative inset.
        #expect(DockMetrics.sheetRoom(cards: 1, keyboardUp: false, screenHeight: 852, stackTop: 900) == 0)
    }

    @Test func theComposerSitsABarGapAboveTheDockOnlyWithCardsAndNoKeyboard() {
        #expect(DockMetrics.composerGap(cards: 1, keyboardUp: false) == DockMetrics.barGap)
        #expect(DockMetrics.composerGap(cards: 5, keyboardUp: false) == 11)
        // Keyboard up, or no cards: its usual concentric gap.
        #expect(DockMetrics.composerGap(cards: 1, keyboardUp: true) == nil)
        #expect(DockMetrics.composerGap(cards: 0, keyboardUp: false) == nil)
        #expect(DockMetrics.composerGap(cards: 0, keyboardUp: true) == nil)
    }

    @Test func onlyAKeyboardTallerThan100PointsIsTheSoftwareKeyboard() {
        // The hardware keyboard's shortcut bar is a few dozen points; the software keyboard is 250+.
        #expect(!DockMetrics.isSoftwareKeyboard(frameHeight: 0))
        #expect(!DockMetrics.isSoftwareKeyboard(frameHeight: 55))
        #expect(!DockMetrics.isSoftwareKeyboard(frameHeight: 100))
        #expect(DockMetrics.isSoftwareKeyboard(frameHeight: 100.5))
        #expect(DockMetrics.isSoftwareKeyboard(frameHeight: 101))
        #expect(DockMetrics.isSoftwareKeyboard(frameHeight: 291))
    }
}
