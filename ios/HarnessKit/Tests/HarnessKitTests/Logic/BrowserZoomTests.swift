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

    /// A tap through a zoomed, panned frame lands on the page pixel under it (Format.toPagePoint
    /// with the zoomed rect, as the Browser tab maps touches).
    @Test(arguments: Fixture.cases("browserZoom", "zoomedTapCases", input: ZoomedTapInput.self, output: Format.Point?.self))
    func zoomedTap(_ c: Fixture.Case<ZoomedTapInput, Format.Point?>) {
        #expect(Format.toPagePoint(c.input.local, drawn: c.input.drawn, page: .init(width: 1280, height: 800)) == c.output)
    }
}
