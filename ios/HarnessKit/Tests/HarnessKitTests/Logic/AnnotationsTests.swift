import Foundation
import Testing
@testable import HarnessKit

/// shared/src/state/annotations.test.ts, case for case, then the phone-only rules around it.
@Suite("Annotations")
struct AnnotationsTests {
    typealias P = Annotations.Point
    typealias Mark = Annotations.DraftMark

    static let W: Double = 1000
    static let H: Double = 500
    static let style = Annotations.style(width: W, height: H)

    static func click(_ x: Double, _ y: Double, _ message: String = "") -> Mark {
        Mark(anchor: P(x: x, y: y), tail: nil, message: message)
    }

    static func arrow(_ ax: Double, _ ay: Double, _ tx: Double, _ ty: Double, _ message: String = "") -> Mark {
        Mark(anchor: P(x: ax, y: ay), tail: P(x: tx, y: ty), message: message)
    }

    @Test func aPressThatMovesLessThanTheThresholdIsAClickAtTheThresholdItsAnArrow() {
        #expect(Annotations.isDrag(P(x: 10, y: 10), P(x: 13, y: 14)) == false) // 5 points
        #expect(Annotations.isDrag(P(x: 10, y: 10), P(x: 16, y: 10)) == true) // 6 points
    }

    @Test func pointsOutsideTheImageAreKeptOnItsEdge() {
        #expect(Annotations.toUnit(P(x: -20, y: 600), width: Self.W, height: Self.H) == P(x: 0, y: 1))
        #expect(Annotations.toUnit(P(x: 250, y: 125), width: Self.W, height: Self.H) == P(x: 0.25, y: 0.25))
        // A zero-size surface or a NaN point stays at the origin rather than producing NaN.
        #expect(Annotations.toUnit(P(x: 5, y: .nan), width: 0, height: Self.H) == P(x: 0, y: 0))
    }

    @Test func deletingAMarkRenumbersTheOnesAfterIt() {
        let marks = [Self.click(0.1, 0.1, "one"), Self.click(0.2, 0.2, "two"), Self.arrow(0.3, 0.3, 0.5, 0.5, "three")]
        #expect(Annotations.marksForMessage(Annotations.remove(marks, at: 1), width: Self.W, height: Self.H) == [
            AnnotationMark(n: 1, x: 100, y: 50, message: "one"),
            AnnotationMark(n: 2, x: 300, y: 150, tailX: 500, tailY: 250, message: "three"),
        ])
    }

    @Test func marksAreSentInImagePixelsRoundedWithTrimmedMessages() {
        #expect(Annotations.marksForMessage([Self.arrow(0.1234, 0.5, 0.0005, 0.9999, "  look here \n")], width: 2880, height: 1800) == [
            AnnotationMark(n: 1, x: 355, y: 900, tailX: 1, tailY: 1800, message: "look here"),
        ])
    }

    @Test func aBadgeWinsOverAnAnchorUnderTheSamePointAndALaterMarkOverAnEarlierOne() {
        // Mark 1's arrow points at (500, 250); mark 2 is a click at the same spot.
        let marks = [Self.arrow(0.5, 0.5, 0.2, 0.2), Self.click(0.5, 0.5)]
        #expect(Annotations.hitTest(marks, P(x: 500, y: 250), width: Self.W, height: Self.H, style: Self.style) == .init(index: 1, part: .badge))
        // Two badges overlapping: the later one is on top.
        #expect(Annotations.hitTest([Self.click(0.5, 0.5), Self.click(0.505, 0.5)], P(x: 503, y: 250), width: Self.W, height: Self.H, style: Self.style) == .init(index: 1, part: .badge))
        // Only the arrow's anchor is there.
        #expect(Annotations.hitTest([Self.arrow(0.5, 0.5, 0.2, 0.2)], P(x: 502, y: 251), width: Self.W, height: Self.H, style: Self.style) == .init(index: 0, part: .anchor))
        #expect(Annotations.hitTest([Self.arrow(0.5, 0.5, 0.2, 0.2)], P(x: 700, y: 400), width: Self.W, height: Self.H, style: Self.style) == nil)
    }

    @Test func movingABadgeMovesAnArrowsTailButAClicksAnchorMovesStayInsideTheImage() {
        let marks = [Self.arrow(0.5, 0.5, 0.2, 0.2), Self.click(0.7, 0.7)]
        #expect(Annotations.move(marks, .init(index: 0, part: .badge), to: P(x: 0.1, y: 0.1))[0] == Self.arrow(0.5, 0.5, 0.1, 0.1))
        #expect(Annotations.move(marks, .init(index: 0, part: .anchor), to: P(x: 0.6, y: 1.4))[0] == Self.arrow(0.6, 1, 0.2, 0.2))
        #expect(Annotations.move(marks, .init(index: 1, part: .badge), to: P(x: 0.9, y: 0.9))[1] == Self.click(0.9, 0.9))
        // The other marks are left alone.
        #expect(Annotations.move(marks, .init(index: 1, part: .badge), to: P(x: 0.9, y: 0.9))[0] == marks[0])
    }

    @Test func theArrowsTipIsOnTheAnchorAndItsLineStartsAtTheBadgesEdge() throws {
        let g = try #require(Annotations.arrowGeometry(tail: P(x: 100, y: 100), anchor: P(x: 400, y: 100), style: Self.style))
        #expect(g.head.0 == P(x: 400, y: 100))
        #expect(g.line.0 == P(x: 100 + Self.style.badgeRadius, y: 100))
        #expect(g.line.1.x < 400)
        #expect(abs(g.head.1.x - (400 - Self.style.headLength)) < 1e-9)
        #expect(abs(abs(g.head.1.y - g.head.2.y) - Self.style.headHalfWidth * 2) < 1e-9)
    }

    @Test func noArrowWhenTheTailIsTooCloseToTheAnchorToShowPastTheBadge() {
        #expect(Annotations.arrowGeometry(tail: P(x: 100, y: 100), anchor: P(x: 100 + Self.style.badgeRadius, y: 100), style: Self.style) == nil)
    }

    @Test func theStyleGrowsWithTheImageSoTheSentPictureMatchesTheScreenWithAFloorForSmallImages() {
        #expect(abs(Annotations.style(width: 2700, height: 1200).badgeRadius - Annotations.style(width: 900, height: 400).badgeRadius * 3) < 1e-9)
        #expect(Annotations.style(width: 100, height: 100).badgeRadius == Annotations.style(width: 300, height: 200).badgeRadius)
    }

    @Test func theTranscriptsLabelCountsNotes() {
        #expect(Annotations.notesLabel(1) == "1 note")
        #expect(Annotations.notesLabel(3) == "3 notes")
    }

    // MARK: Phone-only

    @Test func settingAMessageChangesOnlyThatMark() {
        let marks = [Self.click(0.1, 0.1, "a"), Self.click(0.2, 0.2, "b")]
        #expect(Annotations.setMessage(marks, at: 1, "new") == [Self.click(0.1, 0.1, "a"), Self.click(0.2, 0.2, "new")])
    }

    @Test func theMarkLimitStopsAtFifty() {
        #expect(Annotations.canAdd(Array(repeating: Self.click(0, 0), count: maxAnnotationMarks - 1)))
        #expect(!Annotations.canAdd(Array(repeating: Self.click(0, 0), count: maxAnnotationMarks)))
    }

    @Test func aLongMessageIsCutAtTheLimitWithoutSplittingACharacter() {
        let ok = String(repeating: "a", count: maxAnnotationMessage)
        #expect(Annotations.clampMessage(ok) == ok)
        // 1999 units, then an emoji (2 units) that would cross the limit.
        let crossing = String(repeating: "a", count: maxAnnotationMessage - 1) + "😀"
        #expect(Annotations.clampMessage(crossing) == String(repeating: "a", count: maxAnnotationMessage - 1))
    }

    /// app/src/renderer/state/annotator.test.ts: a browser screenshot is named by its page.
    @Test func aBrowserPageIsNamedByItsHostElseItsTitle() {
        #expect(Annotations.browserShotName(url: "http://127.0.0.1:5173/settings", title: "Settings") == "127.0.0.1")
        #expect(Annotations.browserShotName(url: "HTTP://Example.COM/x", title: "") == "example.com")
        #expect(Annotations.browserShotName(url: "about:blank", title: "Blank") == "Blank")
        #expect(Annotations.browserShotName(url: "not a url", title: "  ") == "page")
    }

    @Test func historyKeepsTheNewestHundred() {
        var h: [Int] = []
        for i in 0..<(Annotations.historyLimit + 5) { h = Annotations.pushHistory(h, i) }
        #expect(h.count == Annotations.historyLimit)
        #expect(h.first == 5)
        #expect(h.last == Annotations.historyLimit + 4)
    }
}

@Suite("Annotations: a browser mark's element (iPhone bookkeeping)")
struct AnnotationElementBookkeepingTests {
    typealias Mark = Annotations.DraftMark
    typealias Point = Annotations.Point
    static let save = BrowserElement(path: "#save", text: "Save")

    @Test func onlyMarksWithoutAnElementAndAnUnsettledAnchorNeedALookup() {
        let marks = [
            Mark(anchor: Point(x: 0.1, y: 0.1), element: Self.save),
            Mark(anchor: Point(x: 0.2, y: 0.2)),
            Mark(anchor: Point(x: 0.3, y: 0.3)),
        ]
        #expect(Annotations.marksNeedingElement(marks, settled: []) == [1, 2])
        #expect(Annotations.marksNeedingElement(marks, settled: [Point(x: 0.3, y: 0.3)]) == [1])
    }

    /// Moving the anchor forgets the element, so the moved mark needs a lookup again.
    @Test func movingTheAnchorAsksAgain() {
        let marks = [Mark(anchor: Point(x: 0.5, y: 0.5), tail: Point(x: 0.2, y: 0.2), element: Self.save)]
        let moved = Annotations.move(marks, Annotations.MarkHit(index: 0, part: .anchor), to: Point(x: 0.6, y: 0.6))
        #expect(Annotations.marksNeedingElement(moved, settled: [Point(x: 0.5, y: 0.5)]) == [0])
        let tail = Annotations.move(marks, Annotations.MarkHit(index: 0, part: .badge), to: Point(x: 0.9, y: 0.9))
        #expect(Annotations.marksNeedingElement(tail, settled: []) == [])
    }

    /// An answer for an anchor the mark has since left (or a mark since deleted) is dropped: the
    /// latest lookup wins.
    @Test func aStaleAnswerIsDropped() {
        let at = Point(x: 0.4, y: 0.4)
        let marks = [Mark(anchor: at)]
        #expect(Annotations.resolveElement(marks, at: 0, anchor: at, Self.save)[0].element == Self.save)
        #expect(Annotations.resolveElement(marks, at: 0, anchor: Point(x: 0.1, y: 0.1), Self.save) == marks)
        #expect(Annotations.resolveElement(marks, at: 3, anchor: at, Self.save) == marks)
        // null clears one that had an element.
        let named = [Mark(anchor: at, element: Self.save)]
        #expect(Annotations.resolveElement(named, at: 0, anchor: at, nil)[0].element == nil)
    }

    @Test func theLabelQuotesTextAndLeavesItOutWhenEmpty() {
        #expect(Annotations.elementLabel(BrowserElement(path: "button:nth-of-type(2)", text: "Sign in")) == "button:nth-of-type(2) · \u{201C}Sign in\u{201D}")
        #expect(Annotations.elementLabel(BrowserElement(path: "body > div", text: "")) == "body > div")
    }

    /// The sent mark carries what was looked up, in the page's terms; reopening keeps it.
    @Test func theElementGoesOutWithTheMarkAndComesBack() {
        let marks = Annotations.setElement([Mark(anchor: Point(x: 0.5, y: 0.25), message: "this")], at: 0, Self.save)
        let sent = Annotations.marksForMessage(marks, width: 800, height: 400)
        #expect(sent == [AnnotationMark(n: 1, x: 400, y: 100, message: "this", path: "#save", text: "Save")])
        #expect(Annotations.draftMarks(width: 800, height: 400, marks: sent)[0].element == Self.save)
    }
}
