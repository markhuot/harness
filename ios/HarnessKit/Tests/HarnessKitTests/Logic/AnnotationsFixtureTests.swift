import Foundation
import Testing
@testable import HarnessKit

/// Parity with shared/src/state/annotations.ts: every case in Fixtures/annotations.json (computed by
/// the TypeScript functions, shared/fixtures/cases/annotations.ts) run through the Swift port.
/// AnnotationsTests holds the hand-ported unit tests; these catch the two drifting apart.
@Suite("state/annotations.ts parity")
struct AnnotationsFixtureTests {
    typealias Point = Annotations.Point

    struct P: Codable, Sendable {
        let x: Double
        let y: Double
        var point: Point { Point(x: x, y: y) }
    }

    struct Mark: Codable, Sendable {
        let anchor: P
        let tail: P?
        let message: String
        var draft: Annotations.DraftMark { .init(anchor: anchor.point, tail: tail?.point, message: message) }
    }

    struct Hit: Codable, Sendable, Equatable {
        let index: Int
        let part: String
        var markHit: Annotations.MarkHit { .init(index: index, part: part == "anchor" ? .anchor : .badge) }
    }

    struct Size: Decodable, Sendable {
        let width: Double
        let height: Double
    }

    struct StyleOut: Decodable, Sendable {
        let badgeRadius, fontSize, lineWidth, outline, headLength, headHalfWidth: Double
    }

    struct DragInput: Decodable, Sendable {
        let start: P
        let end: P
        let threshold: Double?
    }

    struct UnitInput: Decodable, Sendable {
        let p: P
        let width: Double
        let height: Double
    }

    struct ArrowInput: Decodable, Sendable {
        let tail: P
        let anchor: P
        let width: Double
        let height: Double
    }

    struct ArrowOut: Decodable, Sendable {
        let line: [P]
        let head: [P]
    }

    struct HitInput: Decodable, Sendable {
        let marks: [Mark]
        let p: P
        let width: Double
        let height: Double
    }

    struct MoveInput: Decodable, Sendable {
        let marks: [Mark]
        let hit: Hit
        let to: P
    }

    struct MessageInput: Decodable, Sendable {
        let marks: [Mark]
        let width: Double
        let height: Double
    }

    struct RemoveInput: Decodable, Sendable {
        let marks: [Mark]
        let index: Int
        let width: Double
        let height: Double
    }

    struct SetMessageInput: Decodable, Sendable {
        let marks: [Mark]
        let index: Int
        let message: String
    }

    static func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-9 * max(1, abs(a), abs(b)) }
    static func close(_ a: Point, _ b: P) -> Bool { close(a.x, b.x) && close(a.y, b.y) }

    static func expectMarks(_ actual: [Annotations.DraftMark], _ expected: [Mark], _ name: String) {
        #expect(actual.count == expected.count, "\(name): \(actual.count) marks, TS has \(expected.count)")
        for (a, e) in zip(actual, expected) {
            #expect(close(a.anchor, e.anchor), "\(name): anchor \(a.anchor) != \(e.anchor)")
            #expect(a.message == e.message, "\(name): message")
            switch (a.tail, e.tail) {
            case (nil, nil): break
            case let (at?, et?): #expect(close(at, et), "\(name): tail \(at) != \(et)")
            default: Issue.record("\(name): tail \(String(describing: a.tail)) != \(String(describing: e.tail))")
            }
        }
    }

    @Test(arguments: Fixture.cases("annotations", "annotationStyleCases", input: Size.self, output: StyleOut.self))
    func style(_ c: Fixture.Case<Size, StyleOut>) {
        let s = Annotations.style(width: c.input.width, height: c.input.height)
        let e = c.output
        #expect(Self.close(s.badgeRadius, e.badgeRadius))
        #expect(Self.close(s.fontSize, e.fontSize))
        #expect(Self.close(s.lineWidth, e.lineWidth))
        #expect(Self.close(s.outline, e.outline))
        #expect(Self.close(s.headLength, e.headLength))
        #expect(Self.close(s.headHalfWidth, e.headHalfWidth))
    }

    @Test(arguments: Fixture.cases("annotations", "isAnnotationDragCases", input: DragInput.self, output: Bool.self))
    func isDrag(_ c: Fixture.Case<DragInput, Bool>) {
        let r = c.input.threshold.map { Annotations.isDrag(c.input.start.point, c.input.end.point, threshold: $0) }
            ?? Annotations.isDrag(c.input.start.point, c.input.end.point)
        #expect(r == c.output)
    }

    @Test(arguments: Fixture.cases("annotations", "toUnitCases", input: UnitInput.self, output: P.self))
    func toUnit(_ c: Fixture.Case<UnitInput, P>) {
        let r = Annotations.toUnit(c.input.p.point, width: c.input.width, height: c.input.height)
        #expect(Self.close(r, c.output), "\(r) != \(c.output)")
    }

    @Test(arguments: Fixture.cases("annotations", "arrowGeometryCases", input: ArrowInput.self, output: ArrowOut?.self))
    func arrowGeometry(_ c: Fixture.Case<ArrowInput, ArrowOut?>) throws {
        let style = Annotations.style(width: c.input.width, height: c.input.height)
        let r = Annotations.arrowGeometry(tail: c.input.tail.point, anchor: c.input.anchor.point, style: style)
        guard let e = c.output else {
            #expect(r == nil, "Swift drew an arrow TS doesn't")
            return
        }
        let a = try #require(r, "Swift drew no arrow, TS does")
        let line = [a.line.0, a.line.1]
        let head = [a.head.0, a.head.1, a.head.2]
        #expect(e.line.count == 2 && e.head.count == 3)
        for (x, y) in zip(line, e.line) { #expect(Self.close(x, y), "line \(x) != \(y)") }
        for (x, y) in zip(head, e.head) { #expect(Self.close(x, y), "head \(x) != \(y)") }
    }

    @Test(arguments: Fixture.cases("annotations", "hitTestMarksCases", input: HitInput.self, output: Hit?.self))
    func hitTest(_ c: Fixture.Case<HitInput, Hit?>) {
        let i = c.input
        let r = Annotations.hitTest(i.marks.map(\.draft), i.p.point, width: i.width, height: i.height, style: Annotations.style(width: i.width, height: i.height))
        #expect(r == c.output?.markHit)
    }

    @Test(arguments: Fixture.cases("annotations", "moveMarkCases", input: MoveInput.self, output: [Mark].self))
    func move(_ c: Fixture.Case<MoveInput, [Mark]>) {
        Self.expectMarks(Annotations.move(c.input.marks.map(\.draft), c.input.hit.markHit, to: c.input.to.point), c.output, c.name)
    }

    @Test(arguments: Fixture.cases("annotations", "marksForMessageCases", input: MessageInput.self, output: JSONValue.self))
    func marksForMessage(_ c: Fixture.Case<MessageInput, JSONValue>) throws {
        try expectJSONMatchesTS(Annotations.marksForMessage(c.input.marks.map(\.draft), width: c.input.width, height: c.input.height), c.output)
    }

    @Test(arguments: Fixture.cases("annotations", "removeMarkCases", input: RemoveInput.self, output: JSONValue.self))
    func remove(_ c: Fixture.Case<RemoveInput, JSONValue>) throws {
        let left = Annotations.remove(c.input.marks.map(\.draft), at: c.input.index)
        try expectJSONMatchesTS(Annotations.marksForMessage(left, width: c.input.width, height: c.input.height), c.output)
    }

    @Test(arguments: Fixture.cases("annotations", "setMarkMessageCases", input: SetMessageInput.self, output: [Mark].self))
    func setMessage(_ c: Fixture.Case<SetMessageInput, [Mark]>) {
        Self.expectMarks(Annotations.setMessage(c.input.marks.map(\.draft), at: c.input.index, c.input.message), c.output, c.name)
    }

    @Test(arguments: Fixture.cases("annotations", "annotationNotesLabelCases", input: Int.self, output: String.self))
    func notesLabel(_ c: Fixture.Case<Int, String>) {
        #expect(Annotations.notesLabel(c.input) == c.output)
    }

    struct SameInput: Decodable, Sendable {
        let a: AttachmentAnnotation?
        let b: AttachmentAnnotation?
    }

    @Test(arguments: Fixture.cases("annotations", "sameAnnotationCases", input: SameInput.self, output: Bool.self))
    func sameAnnotation(_ c: Fixture.Case<SameInput, Bool>) {
        #expect(Annotations.same(c.input.a, c.input.b) == c.output, "\(c.name)")
        #expect(Annotations.same(c.input.b, c.input.a) == c.output, "\(c.name), swapped")
    }

    @Test(arguments: Fixture.cases("annotations", "draftMarksFromCases", input: AttachmentAnnotation.self, output: [Mark].self))
    func draftMarksFrom(_ c: Fixture.Case<AttachmentAnnotation, [Mark]>) {
        Self.expectMarks(Annotations.draftMarks(from: c.input), c.output, c.name)
    }
}
