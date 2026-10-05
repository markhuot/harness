import Foundation
import Testing
@testable import HarnessKit

struct ZoomScaleInput: Decodable, Sendable {
    let fit: Format.Rect
    let drawn: Format.Rect
}

struct ZoomRectInput: Decodable, Sendable {
    let box: BrowserZoom.Box
    let fit: Format.Rect
    let drawn: Format.Rect
    /// JSON has no NaN: the TS case's NaN factor arrives as null.
    let factor: Double?
    let anchor: Format.Point
}

struct PanRectInput: Decodable, Sendable {
    let box: BrowserZoom.Box
    let fit: Format.Rect
    let drawn: Format.Rect
    let dx: Double
    let dy: Double
}

struct ClampZoomRectInput: Decodable, Sendable {
    let box: BrowserZoom.Box
    let fit: Format.Rect
    let rect: Format.Rect
}

struct ZoomedTapInput: Decodable, Sendable {
    let local: Format.Point
    let drawn: Format.Rect
}

struct BrowserZoomConstants: Decodable {
    let BROWSER_ZOOM_MAX: Double
}

@Suite("BrowserZoom")
struct BrowserZoomTests {
    @Test("BROWSER_ZOOM_MAX matches the TS")
    func constants() throws {
        let c = try Fixture.value("browserZoom", "constants", as: BrowserZoomConstants.self)
        #expect(BrowserZoom.maxScale == c.BROWSER_ZOOM_MAX)
    }

    @Test(arguments: Fixture.cases("browserZoom", "zoomScaleCases", input: ZoomScaleInput.self, output: Double.self))
    func zoomScale(_ c: Fixture.Case<ZoomScaleInput, Double>) {
        #expect(BrowserZoom.zoomScale(fit: c.input.fit, drawn: c.input.drawn) == c.output)
    }

    @Test(arguments: Fixture.cases("browserZoom", "zoomRectCases", input: ZoomRectInput.self, output: Format.Rect.self))
    func zoomRect(_ c: Fixture.Case<ZoomRectInput, Format.Rect>) {
        let i = c.input
        #expect(BrowserZoom.zoomRect(box: i.box, fit: i.fit, drawn: i.drawn, factor: i.factor ?? .nan, anchor: i.anchor) == c.output)
    }

    @Test(arguments: Fixture.cases("browserZoom", "panRectCases", input: PanRectInput.self, output: Format.Rect.self))
    func panRect(_ c: Fixture.Case<PanRectInput, Format.Rect>) {
        let i = c.input
        #expect(BrowserZoom.panRect(box: i.box, fit: i.fit, drawn: i.drawn, dx: i.dx, dy: i.dy) == c.output)
    }

    @Test(arguments: Fixture.cases("browserZoom", "clampZoomRectCases", input: ClampZoomRectInput.self, output: Format.Rect.self))
    func clampZoomRect(_ c: Fixture.Case<ClampZoomRectInput, Format.Rect>) {
        let i = c.input
        #expect(BrowserZoom.clampZoomRect(box: i.box, fit: i.fit, rect: i.rect) == c.output)
    }

    private static func p(_ x: Double, _ y: Double) -> Format.Point { .init(x: x, y: y) }

    @Test func pinchStepsScaleAroundTheOldCenterAndPanByItsMove() {
        var pinch = BrowserPinch()
        #expect(pinch.move(Self.p(0, 0), Self.p(10, 0)) == nil) // nothing begun
        pinch.begin(Self.p(100, 100), Self.p(200, 100), at: 0)
        // Fingers spread to twice the distance, and the center moves 20 right.
        #expect(pinch.move(Self.p(70, 100), Self.p(270, 100)) == .init(factor: 2, anchor: Self.p(150, 100), dx: 20, dy: 0))
        // The next step is relative to the last one, not to the start.
        #expect(pinch.move(Self.p(70, 110), Self.p(270, 110)) == .init(factor: 1, anchor: Self.p(170, 100), dx: 0, dy: 10))
        #expect(pinch.end(at: 1000) == false)
        #expect(!pinch.active)
    }

    @Test func aPinchStepKeepsThePagePointUnderTheFingers() {
        // A desktop page letterboxed onto a phone stage, already 2× around the center.
        let box = BrowserZoom.Box(w: 390, h: 700)
        let fit = Format.fitRect(boxW: 390, boxH: 700, w: 1280, h: 800)
        let twice = BrowserZoom.zoomRect(box: box, fit: fit, drawn: fit, factor: 2, anchor: Self.p(195, 350))
        let page = Format.Size(width: 1280, height: 800)
        let under = Format.toPagePoint(Self.p(150, 350), drawn: twice, page: page)
        let next = BrowserZoom.apply(.init(factor: 1.5, anchor: Self.p(150, 350), dx: 30, dy: 0), box: box, fit: fit, drawn: twice)
        #expect(BrowserZoom.zoomScale(fit: fit, drawn: next) == 3)
        #expect(Format.toPagePoint(Self.p(180, 350), drawn: next, page: page) == under)
        // Pinching back past 1× lands exactly on the fit.
        #expect(BrowserZoom.apply(.init(factor: 0.3, anchor: Self.p(150, 350), dx: 5, dy: 5), box: box, fit: fit, drawn: next) == fit)
    }

    @Test func pinchWithBothFingersOnOnePointDoesNotDivideByZero() {
        var pinch = BrowserPinch()
        pinch.begin(Self.p(50, 50), Self.p(50, 50), at: 0)
        #expect(pinch.move(Self.p(40, 50), Self.p(60, 50))?.factor == 1)
    }

    @Test func twoQuickTwoFingerTapsReset() {
        var pinch = BrowserPinch()
        pinch.begin(Self.p(100, 100), Self.p(200, 100), at: 0)
        #expect(pinch.end(at: 100) == false)
        pinch.begin(Self.p(100, 100), Self.p(200, 100), at: 300)
        #expect(pinch.end(at: 400) == true)
        // A third tap starts a new pair rather than resetting again.
        pinch.begin(Self.p(100, 100), Self.p(200, 100), at: 500)
        #expect(pinch.end(at: 600) == false)
    }

    @Test func slowOrMovingOrLateTapsDoNotReset() {
        var slow = BrowserPinch()
        slow.begin(Self.p(100, 100), Self.p(200, 100), at: 0)
        _ = slow.end(at: 100)
        slow.begin(Self.p(100, 100), Self.p(200, 100), at: 200)
        #expect(slow.end(at: 600) == false) // held too long to be a tap

        var moving = BrowserPinch()
        moving.begin(Self.p(100, 100), Self.p(200, 100), at: 0)
        _ = moving.end(at: 100)
        moving.begin(Self.p(100, 100), Self.p(200, 100), at: 200)
        _ = moving.move(Self.p(80, 100), Self.p(220, 100))
        #expect(moving.end(at: 300) == false) // a pinch, not a tap

        var late = BrowserPinch()
        late.begin(Self.p(100, 100), Self.p(200, 100), at: 0)
        _ = late.end(at: 100)
        late.begin(Self.p(100, 100), Self.p(200, 100), at: 451)
        #expect(late.end(at: 500) == false) // too long after the first

        var cancelled = BrowserPinch()
        cancelled.begin(Self.p(100, 100), Self.p(200, 100), at: 0)
        _ = cancelled.end(at: 100)
        cancelled.cancel()
        cancelled.begin(Self.p(100, 100), Self.p(200, 100), at: 200)
        #expect(cancelled.end(at: 300) == false)
    }

    /// A tap through a zoomed, panned frame lands on the page pixel under it (Format.toPagePoint
    /// with the zoomed rect, as the Browser tab maps touches).
    @Test(arguments: Fixture.cases("browserZoom", "zoomedTapCases", input: ZoomedTapInput.self, output: Format.Point?.self))
    func zoomedTap(_ c: Fixture.Case<ZoomedTapInput, Format.Point?>) {
        #expect(Format.toPagePoint(c.input.local, drawn: c.input.drawn, page: .init(width: 1280, height: 800)) == c.output)
    }
}
