import Foundation
import Testing
@testable import HarnessKit

// fitRect / toPagePoint from shared/src/state/format.ts, which the TS tests and the RN screen use to
// build `toPage`. Test-only here (the format.ts port is other work).
private struct DrawnRect {
    var x: Double, y: Double, w: Double, h: Double
}

private func fitRect(_ boxW: Double, _ boxH: Double, _ w: Double, _ h: Double) -> DrawnRect {
    if w == 0 || h == 0 || boxW == 0 || boxH == 0 { return DrawnRect(x: 0, y: 0, w: 0, h: 0) }
    let scale = min(boxW / w, boxH / h)
    let dw = w * scale
    let dh = h * scale
    return DrawnRect(x: (boxW - dw) / 2, y: (boxH - dh) / 2, w: dw, h: dh)
}

private func toPagePoint(_ p: TouchGesture.Point, _ drawn: DrawnRect, _ page: (width: Double, height: Double)) -> TouchGesture.Point? {
    if drawn.w == 0 || drawn.h == 0 || page.width == 0 || page.height == 0 { return nil }
    let lx = p.x - drawn.x
    let ly = p.y - drawn.y
    if lx < 0 || ly < 0 || lx > drawn.w || ly > drawn.h { return nil }
    return .init(x: JSCompat.round(lx / drawn.w * page.width), y: JSCompat.round(ly / drawn.h * page.height))
}

private func makeGesture(
    stage: (w: Double, h: Double) = (400, 400), page: (width: Double, height: Double)? = (1280, 800),
    configure: (inout TouchGesture.Options) -> Void = { _ in }
) -> TouchGesture {
    let drawn = page.map { fitRect(stage.w, stage.h, $0.width, $0.height) } ?? DrawnRect(x: 0, y: 0, w: 0, h: 0)
    var o = TouchGesture.Options(
        toPage: { p in page.flatMap { toPagePoint(p, drawn, $0) } },
        scale: { if let page, drawn.w != 0 { page.width / drawn.w } else { 1 } }
    )
    configure(&o)
    return TouchGesture(o)
}

private func pt(_ x: Double, _ y: Double) -> TouchGesture.Point { .init(x: x, y: y) }
private func move(_ x: Double, _ y: Double) -> BrowserInput { .mouse(.init(action: .move, x: x, y: y)) }
private func down(_ x: Double, _ y: Double, _ n: Int = 1) -> BrowserInput { .mouse(.init(action: .down, x: x, y: y, button: .left, clickCount: n)) }
private func up(_ x: Double, _ y: Double, _ n: Int = 1) -> BrowserInput { .mouse(.init(action: .up, x: x, y: y, button: .left, clickCount: n)) }
private func wheel(_ x: Double, _ y: Double, _ dx: Double, _ dy: Double) -> BrowserInput {
    .mouse(.init(action: .wheel, x: x, y: y, deltaX: dx, deltaY: dy))
}
private func clickCount(_ i: BrowserInput) -> Int? {
    if case let .mouse(m) = i { return m.clickCount }
    return nil
}
private let backspace: [BrowserInput] = [
    .key(.init(action: .down, key: "Backspace", code: "Backspace")), .key(.init(action: .up, key: "Backspace", code: "Backspace")),
]

// MARK: - Direct ports of browserInput.test.ts

@Suite("browserInput.test.ts: TouchGesture")
struct TouchGestureTests {
    @Test func tapIsMoveDownUpAtThePagePoint() {
        let g = makeGesture()
        #expect(g.begin(pt(200, 200), at: 0) == [])
        #expect(g.move(pt(203, 201), at: 40) == []) // within slop: still a tap
        #expect(g.end(pt(203, 201), at: 90) == [move(650, 403), down(650, 403), up(650, 403)])
    }

    @Test func twoQuickTapsNearbyDoubleClick_slowOrDistantSecondTapIsNew() {
        let g = makeGesture()
        _ = g.begin(pt(100, 100), at: 0)
        _ = g.end(pt(100, 100), at: 50)
        _ = g.begin(pt(104, 102), at: 200)
        #expect(g.end(pt(104, 102), at: 250).map(clickCount) == [nil, 2, 2])
        _ = g.begin(pt(104, 102), at: 2000)
        #expect(clickCount(g.end(pt(104, 102), at: 2050)[1]) == 1)
        _ = g.begin(pt(300, 300), at: 2100)
        #expect(clickCount(g.end(pt(300, 300), at: 2150)[1]) == 1)
    }

    @Test func tapsInTheLetterboxBarsDoNothing() {
        let g = makeGesture()
        _ = g.begin(pt(200, 20), at: 0)
        #expect(g.end(pt(200, 20), at: 30) == [])
    }

    @Test func panScrollsFingerUpPositiveDeltaYInPagePixels() {
        let g = makeGesture()
        _ = g.begin(pt(200, 300), at: 0)
        let first = g.move(pt(200, 280), at: 30)
        #expect(g.state == .pan)
        #expect(first == [wheel(640, 656, 0, 64)])
        // Horizontal drag right → negative deltaX (content moves with the finger)
        #expect(g.move(pt(210, 280), at: 60) == [wheel(672, 656, -32, 0)])
        #expect(g.end(pt(210, 280), at: 90) == []) // no click after a pan
    }

    @Test func panThatLeavesTheFrameKeepsScrollingAtTheLastPagePoint() {
        let g = makeGesture()
        _ = g.begin(pt(200, 100), at: 0)
        _ = g.move(pt(200, 90), at: 20)
        #expect(g.move(pt(200, 40), at: 40) == [wheel(640, 48, 0, 160)]) // above the drawn frame now
    }

    @Test func holdThenMoveDrags() {
        let g = makeGesture()
        _ = g.begin(pt(100, 200), at: 0)
        #expect(g.move(pt(101, 200), at: 500) == []) // still inside slop
        let started = g.move(pt(130, 200), at: 600)
        #expect(g.state == .drag)
        #expect(started == [move(320, 400), down(320, 400), move(416, 400)])
        #expect(g.end(pt(150, 200), at: 700) == [up(480, 400)])
    }

    @Test func cancelMidDragReleases_cancelMidPanSendsNothing() {
        let g = makeGesture()
        _ = g.begin(pt(100, 200), at: 0)
        _ = g.move(pt(130, 200), at: 600)
        #expect(g.cancel() == [up(416, 400)])
        _ = g.begin(pt(100, 200), at: 1000)
        _ = g.move(pt(100, 150), at: 1010)
        #expect(g.cancel() == [])
        #expect(g.move(pt(1, 1), at: 1020) == []) // idle after cancel
    }
}

@Suite("browserInput.test.ts: keyboard and resize")
struct BrowserTypingTests {
    @Test func textDeltaTypingDeletingAutocorrect() {
        #expect(BrowserTyping.textDelta("", "a") == .init(deletes: 0, insert: "a"))
        #expect(BrowserTyping.textDelta("hel", "hello") == .init(deletes: 0, insert: "lo"))
        #expect(BrowserTyping.textDelta("hello", "hel") == .init(deletes: 2, insert: ""))
        #expect(BrowserTyping.textDelta("teh", "the") == .init(deletes: 2, insert: "he"))
        #expect(BrowserTyping.textDelta("x", "x") == .init(deletes: 0, insert: ""))
    }

    @Test func changesBecomeBackspacesAndOneInsert() {
        #expect(BrowserTyping.textChangeInputs("teh", "the ") == backspace + backspace + [.text(text: "he ")])
        #expect(BrowserTyping.textChangeInputs("a", "a") == [])
    }

    @Test func namedKeysPressAndRelease_printableKeysAreLeftToText() {
        #expect(BrowserTyping.keyPress("Enter") == [.key(.init(action: .down, key: "Enter", code: "Enter")), .key(.init(action: .up, key: "Enter", code: "Enter"))])
        #expect(BrowserTyping.keyPress("a") == [])
        #expect(BrowserTyping.keyPress(" ") == [])
    }

    @Test func resizeGateWaitsForConfirmThenOnlyRealChanges() {
        var g = ResizeGate()
        #expect(g.take(width: 390, height: 600) == nil)
        #expect(g.confirm() == true)
        #expect(g.confirm() == false)
        #expect(g.take(width: 390.4, height: 600.2) == .resize(width: 390, height: 600))
        #expect(g.take(width: 390, height: 600) == nil)
        #expect(g.take(width: 0, height: 600) == nil)
        #expect(g.take(width: 390, height: 520) == .resize(width: 390, height: 520))
        g.reset() // reconnect: the service-side subscription starts over, so resend once confirmed
        #expect(g.take(width: 390, height: 520) == nil)
        _ = g.confirm()
        #expect(g.take(width: 390, height: 520) == .resize(width: 390, height: 520))
    }

    // Swift-only: TS would emit width NaN/Infinity; an Int can't, so these are refused.
    @Test(arguments: [Double.nan, .infinity, -.infinity, 1e300])
    func resizeGateRefusesNonIntegralSizes(_ bad: Double) {
        var g = ResizeGate()
        _ = g.confirm()
        #expect(g.take(width: bad, height: 600) == nil)
        #expect(g.take(width: 600, height: bad) == nil)
        #expect(g.take(width: 600, height: 600) == .resize(width: 600, height: 600))
    }

    // Swift-only: Object.prototype names aren't named keys.
    @Test(arguments: ["toString", "constructor", "__proto__", "hasOwnProperty"])
    func prototypeNamesAreNotKeys(_ key: String) {
        #expect(BrowserTyping.keyPress(key) == [])
    }
}

// MARK: - Fixtures computed by the TS implementation

private struct GestureEvent: Decodable, Sendable {
    let t: String
    let x: Double?
    let y: Double?
    let at: Double?
}

private struct GestureOptionsInput: Decodable, Sendable {
    let slop: Double?
    let longPressMs: Double?
    let doubleTapMs: Double?
    let doubleTapSlop: Double?
}

private struct GestureInput: Decodable, Sendable {
    struct Stage: Decodable, Sendable { let w: Double; let h: Double }
    struct Page: Decodable, Sendable { let width: Double; let height: Double }
    let stage: Stage
    let page: Page?
    let options: GestureOptionsInput?
    let events: [GestureEvent]
}

private struct GestureOutput: Decodable, Sendable {
    let outputs: [[BrowserInput]]
    let states: [TouchGesture.Mode]
}

private struct TextPair: Decodable, Sendable {
    let prev: String
    let next: String
}

private struct SplitSurrogateOutput: Decodable, Sendable {
    let deletes: Int
    let insertCodeUnits: [UInt16]
}

private struct GateOp: Decodable, Sendable {
    let op: String
    let width: Double?
    let height: Double?
}

/// A resizeGate step's result: Bool for confirm, BrowserInput? for take, null for reset.
private enum GateResult: Decodable, Sendable, Equatable {
    case bool(Bool)
    case input(BrowserInput?)

    init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = .bool(b) } else { self = .input(try c.decode(BrowserInput?.self)) }
    }
}

@Suite("browserInput.ts parity")
struct BrowserInputFixtureTests {
    @Test(arguments: Fixture.cases("browserInput", "gestureCases", input: GestureInput.self, output: GestureOutput.self))
    fileprivate func gesture(_ c: Fixture.Case<GestureInput, GestureOutput>) {
        let i = c.input
        let g = makeGesture(stage: (i.stage.w, i.stage.h), page: i.page.map { ($0.width, $0.height) }) { o in
            if let v = i.options?.slop { o.slop = v }
            if let v = i.options?.longPressMs { o.longPressMs = v }
            if let v = i.options?.doubleTapMs { o.doubleTapMs = v }
            if let v = i.options?.doubleTapSlop { o.doubleTapSlop = v }
        }
        var outputs: [[BrowserInput]] = []
        var states: [TouchGesture.Mode] = []
        for e in i.events {
            let p = pt(e.x ?? 0, e.y ?? 0)
            switch e.t {
            case "begin": outputs.append(g.begin(p, at: e.at!))
            case "move": outputs.append(g.move(p, at: e.at!))
            case "end": outputs.append(g.end(p, at: e.at!))
            default: outputs.append(g.cancel())
            }
            states.append(g.state)
        }
        #expect(outputs == c.output.outputs)
        #expect(states == c.output.states)
    }

    @Test(arguments: Fixture.cases("browserInput", "textDeltaCases", input: TextPair.self, output: BrowserTyping.Delta.self))
    fileprivate func textDelta(_ c: Fixture.Case<TextPair, BrowserTyping.Delta>) {
        #expect(BrowserTyping.textDelta(c.input.prev, c.input.next) == c.output)
    }

    @Test(arguments: Fixture.cases("browserInput", "textDeltaSplitSurrogateCases", input: TextPair.self, output: SplitSurrogateOutput.self))
    fileprivate func textDeltaSplitSurrogate(_ c: Fixture.Case<TextPair, SplitSurrogateOutput>) {
        let d = BrowserTyping.textDelta(c.input.prev, c.input.next)
        #expect(d.deletes == c.output.deletes)
        // Lone surrogates (which a Swift String can't hold) become U+FFFD; everything else matches.
        let expected = c.output.insertCodeUnits.enumerated().map { i, u -> UInt16 in
            let units = c.output.insertCodeUnits
            let isHigh = (0xD800...0xDBFF).contains(u), isLow = (0xDC00...0xDFFF).contains(u)
            let pairedHigh = isHigh && i + 1 < units.count && (0xDC00...0xDFFF).contains(units[i + 1])
            let pairedLow = isLow && i > 0 && (0xD800...0xDBFF).contains(units[i - 1])
            return (isHigh && !pairedHigh) || (isLow && !pairedLow) ? 0xFFFD : u
        }
        #expect(Array(d.insert.utf16) == expected)
    }

    @Test(arguments: Fixture.cases("browserInput", "textChangeInputsCases", input: TextPair.self, output: [BrowserInput].self))
    fileprivate func textChangeInputs(_ c: Fixture.Case<TextPair, [BrowserInput]>) {
        #expect(BrowserTyping.textChangeInputs(c.input.prev, c.input.next) == c.output)
    }

    @Test(arguments: Fixture.cases("browserInput", "keyPressCases", input: String.self, output: [BrowserInput].self))
    func keyPress(_ c: Fixture.Case<String, [BrowserInput]>) {
        #expect(BrowserTyping.keyPress(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("browserInput", "resizeGateCases", input: [GateOp].self, output: [GateResult].self))
    fileprivate func resizeGate(_ c: Fixture.Case<[GateOp], [GateResult]>) {
        var g = ResizeGate()
        let got: [GateResult] = c.input.map { o in
            switch o.op {
            case "take": .input(g.take(width: o.width!, height: o.height!))
            case "confirm": .bool(g.confirm())
            default:
                { g.reset(); return .input(nil) }()
            }
        }
        #expect(got == c.output)
    }
}

// MARK: - Swift-only: screen glue ported from BrowserTab.tsx

@Suite("BrowserTab wheel coalescing and hidden input")
struct BrowserScreenGlueTests {
    @Test func wheelsAreHeldAndSummedUntilTheDeadline() {
        var w = WheelCoalescer()
        #expect(w.push([wheel(10, 10, 0, 5)], at: 1000) == [])
        #expect(w.deadline == 1033)
        #expect(w.push([wheel(12, 14, -2, 7)], at: 1020) == [])
        #expect(w.deadline == 1033) // the first wheel of the batch arms the timer; later ones don't push it out
        #expect(w.tick(now: 1032.9) == []) // early wake-up
        #expect(w.tick(now: 1033) == [wheel(12, 14, -2, 12)])
        #expect(w.deadline == nil)
        #expect(w.tick(now: 2000) == [])
    }

    @Test func otherInputFlushesThePendingWheelFirst() {
        var w = WheelCoalescer()
        _ = w.push([wheel(1, 1, 0, 3)], at: 0)
        let out = w.push([down(5, 5), wheel(6, 6, 0, 4)], at: 10)
        #expect(out == [wheel(1, 1, 0, 3), down(5, 5)])
        #expect(w.deadline == 43) // the new wheel started a new batch
        #expect(w.flush() == [wheel(6, 6, 0, 4)])
    }

    @Test func batchThatSumsToZeroSendsNothing() {
        var w = WheelCoalescer()
        _ = w.push([wheel(1, 1, 3, 0), wheel(1, 1, -3, 0)], at: 0)
        #expect(w.tick(now: 33) == [])
        #expect(w.deadline == nil)
        // A zero-delta wheel straight from the gesture (sub-pixel pan) is absorbed the same way.
        _ = w.push([wheel(1, 1, 0, 0)], at: 100)
        #expect(w.push([up(1, 1)], at: 101) == [up(1, 1)])
    }

    @Test func coalescesARealPanFromTheGesture() {
        let g = makeGesture()
        var w = WheelCoalescer()
        _ = g.begin(pt(200, 300), at: 0)
        var sent = w.push(g.move(pt(200, 290), at: 10), at: 10)
        sent += w.push(g.move(pt(200, 280), at: 20), at: 20)
        sent += w.tick(now: 43)
        #expect(sent == [wheel(640, 656, 0, 64)])
    }

    @Test func hiddenInputDiffsAndClearsPastTheLimit() {
        var h = BrowserTyping.HiddenInput(limit: 5)
        #expect(h.change(to: "teh").inputs == [.text(text: "teh")])
        let r = h.change(to: "the")
        #expect(r.inputs == backspace + backspace + [.text(text: "he")])
        #expect(r.clear == false)
        #expect(h.change(to: "the 1").clear == false) // exactly at the limit
        let over = h.change(to: "the 12")
        #expect(over.inputs == [.text(text: "2")])
        #expect(over.clear == true)
        #expect(h.typed == "")
        // After the clear the field is empty, so the next keystroke is a plain insert.
        #expect(h.change(to: "x").inputs == [.text(text: "x")])
    }

    @Test func hiddenInputLimitCountsUTF16() {
        var h = BrowserTyping.HiddenInput(limit: 3)
        #expect(h.change(to: "a😀").clear == false) // 3 code units
        #expect(h.change(to: "😀😀").clear == true) // 4 code units, 2 characters
    }
}
