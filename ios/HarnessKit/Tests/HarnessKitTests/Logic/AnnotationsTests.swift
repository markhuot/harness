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

    @Test func annotationsAreFoundByAttachmentSkippingOutOfRangeAndEmptyOnes() {
        let src = AnnotationSource.attachment(id: "att_1", name: "a.png")
        let mark = AnnotationMark(n: 1, x: 1, y: 1, message: "x")
        let list = [
            MessageAnnotation(attachment: 1, source: src, width: 10, height: 10, marks: [mark]),
            MessageAnnotation(attachment: 3, source: src, width: 10, height: 10, marks: [mark]),
            MessageAnnotation(attachment: 0, source: src, width: 10, height: 10, marks: []),
            MessageAnnotation(attachment: 1, source: src, width: 99, height: 99, marks: [mark]),
        ]
        let found = Annotations.byAttachment(list, attachments: 2)
        #expect(Array(found.keys) == [1])
        #expect(found[1]?.width == 10)
        #expect(Annotations.byAttachment(nil, attachments: 2).isEmpty)
    }

    // app/src/renderer/state/annotator.test.ts "names", case for case.

    @Test func annotatedBaseWithTheExtensionTheEncodingHasMadeSafeForAFileName() {
        #expect(Annotations.annotatedName("mockup", jpeg: false) == "annotated-mockup.png")
        #expect(Annotations.annotatedName("Screen Shot 2026", jpeg: true) == "annotated-Screen-Shot-2026.jpg")
        #expect(Annotations.annotatedName("127.0.0.1", jpeg: false) == "annotated-127.0.0.1.png")
        #expect(Annotations.annotatedName("", jpeg: false) == "annotated-image.png")
        #expect(Annotations.annotatedName("???", jpeg: false) == "annotated-image.png")
        #expect(Annotations.annotatedName(String(repeating: "a", count: 100), jpeg: false) == "annotated-\(String(repeating: "a", count: 80)).png")
    }

    @Test func stripExtensionDropsAFilesExtensionAndFoldersNotAVersionOrAnAddress() {
        #expect(Annotations.stripExtension("/Users/me/Shots/Screen Shot.jpeg") == "Screen Shot")
        #expect(Annotations.stripExtension("mockup.png") == "mockup")
        #expect(Annotations.stripExtension("Settings mockup") == "Settings mockup")
        #expect(Annotations.stripExtension("release 1.2") == "release 1.2")
    }

    @Test func aBrowserPageIsNamedByItsHostElseItsTitle() {
        #expect(Annotations.browserShotName(url: "http://127.0.0.1:5173/settings", title: "Settings") == "127.0.0.1")
        #expect(Annotations.browserShotName(url: "about:blank", title: "Blank") == "Blank")
        #expect(Annotations.browserShotName(url: "not a url", title: "  ") == "page")
    }

    @Test func theAnnotatedNameFollowsTheSource() {
        #expect(Annotations.annotatedName(.attachment(id: "att_1", name: "shot.png"), jpeg: false) == "annotated-shot.png")
        #expect(Annotations.annotatedName(.messageAttachment(entryId: "e", index: 0, name: "Photo.HEIC"), jpeg: true) == "annotated-Photo.jpg")
        let browser = AnnotationSource.browser(url: "http://localhost:3000/x", title: "Home", tabId: 1, viewport: .init(width: 1, height: 1), scale: 1)
        #expect(Annotations.annotatedName(browser, jpeg: false) == "annotated-localhost.png")
    }

    // MARK: Encoding (app/src/renderer/state/annotator.test.ts)

    /// An encoder whose PNG is `png` bytes and whose JPEG at quality q is `jpeg(q)` bytes, logging
    /// what was asked.
    final class FakeEncoder {
        var asked: [Double?] = []
        let png: Int
        let jpeg: (Double) -> Int?
        init(png: Int, jpeg: @escaping (Double) -> Int?) {
            self.png = png
            self.jpeg = jpeg
        }
        func callAsFunction(_ q: Double?) -> Data? {
            asked.append(q)
            guard let q else { return Data(count: png) }
            return jpeg(q).map { Data(count: $0) }
        }
    }

    @Test func aPngWithinTheLimitGoesAsIsWithoutTryingJpeg() {
        let enc = FakeEncoder(png: 100, jpeg: { _ in 1 })
        #expect(Annotations.encodeWithinLimit(limit: 100) { enc($0) } == .init(data: Data(count: 100), jpeg: false))
        #expect(enc.asked == [nil])
    }

    @Test func overTheLimitTheBestJpegThatFitsGoes() {
        let enc = FakeEncoder(png: 500, jpeg: { q in q >= 0.75 ? 200 : 90 })
        #expect(Annotations.encodeWithinLimit(limit: 100) { enc($0) } == .init(data: Data(count: 90), jpeg: true))
        #expect(enc.asked == [nil, 0.9, 0.8, 0.7])
    }

    @Test func whenNothingFitsTheSmallestTriedGoes() {
        let enc = FakeEncoder(png: 500, jpeg: { q in Int(1000 * q) - 200 })
        #expect(Annotations.encodeWithinLimit(limit: 100) { enc($0) } == .init(data: Data(count: 300), jpeg: true))
        // A PNG smaller than every JPEG stays the PNG.
        #expect(Annotations.encodeWithinLimit(limit: 100) { q in q == nil ? Data(count: 150) : Data(count: 400) } == .init(data: Data(count: 150), jpeg: false))
    }

    @Test func historyKeepsTheNewestHundred() {
        var h: [Int] = []
        for i in 0..<(Annotations.historyLimit + 5) { h = Annotations.pushHistory(h, i) }
        #expect(h.count == Annotations.historyLimit)
        #expect(h.first == 5)
        #expect(h.last == Annotations.historyLimit + 4)
    }
}
