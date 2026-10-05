import Foundation

// Pinch-zoom of a browser tab's frame in the Browser tab's stage. The frame is drawn letterboxed
// (Format.fitRect); zooming scales that drawn rect 1–maxScale× around the pinch and panning moves
// it. Only the app's view changes: the page never sees the pinch. Touches map through the zoomed
// rect with Format.toPagePoint, like the unzoomed one.
//
// Port of shared/src/state/browserZoom.ts, held to it by Fixtures/browserZoom.json.

public enum BrowserZoom {
    public typealias Rect = Format.Rect

    public struct Box: Codable, Sendable, Equatable {
        public var w: Double
        public var h: Double
        public init(w: Double, h: Double) {
            self.w = w
            self.h = h
        }
    }

    /// BROWSER_ZOOM_MAX
    public static let maxScale: Double = 4

    /// Below this the frame snaps back to its fitted size, so a pinch out lands exactly on 1×.
    private static let snap = 1.01

    /// How far the drawn rect is zoomed from the fitted one (1 = not zoomed).
    public static func zoomScale(fit: Rect, drawn: Rect) -> Double {
        fit.w > 0 ? drawn.w / fit.w : 1
    }

    /// Keep a zoomed rect covering the box: along an axis where it's wider (or taller) than the
    /// box, no gap may show at either edge; where it isn't, it's centered, as the fitted frame is.
    public static func clampZoomRect(box: Box, fit: Rect, rect: Rect) -> Rect {
        if !truthy(fit.w) || !truthy(fit.h) { return fit }
        if zoomScale(fit: fit, drawn: rect) < snap { return fit }
        func axis(_ pos: Double, _ size: Double, _ room: Double) -> Double {
            size <= room ? (room - size) / 2 : min(0, max(room - size, pos))
        }
        return Rect(x: axis(rect.x, rect.w, box.w), y: axis(rect.y, rect.h, box.h), w: rect.w, h: rect.h)
    }

    /// Zoom the drawn rect by `factor` (a pinch's scale change) around `anchor` (the pinch's
    /// center, in box coordinates): the page point under the anchor stays under it. The zoom is
    /// held to 1–maxScale× of the fitted size.
    public static func zoomRect(box: Box, fit: Rect, drawn: Rect, factor: Double, anchor: Format.Point) -> Rect {
        if !truthy(fit.w) || !truthy(fit.h) || !truthy(drawn.w) || !factor.isFinite || factor <= 0 {
            return clampZoomRect(box: box, fit: fit, rect: drawn)
        }
        let scale = min(maxScale, max(1, zoomScale(fit: fit, drawn: drawn) * factor))
        let w = fit.w * scale
        let h = fit.h * scale
        let ratio = w / drawn.w
        let x = anchor.x - (anchor.x - drawn.x) * ratio
        let y = anchor.y - (anchor.y - drawn.y) * ratio
        return clampZoomRect(box: box, fit: fit, rect: Rect(x: x, y: y, w: w, h: h))
    }

    /// Move a zoomed rect by (dx, dy), kept covering the box. At 1× nothing moves.
    public static func panRect(box: Box, fit: Rect, drawn: Rect, dx: Double, dy: Double) -> Rect {
        clampZoomRect(box: box, fit: fit, rect: Rect(x: drawn.x + dx, y: drawn.y + dy, w: drawn.w, h: drawn.h))
    }

    /// One pinch step: zoom around the old center, then pan by the center's move, so the page point
    /// that was under the fingers stays under them.
    public static func apply(_ step: BrowserPinch.Step, box: Box, fit: Rect, drawn: Rect) -> Rect {
        panRect(box: box, fit: fit, drawn: zoomRect(box: box, fit: fit, drawn: drawn, factor: step.factor, anchor: step.anchor), dx: step.dx, dy: step.dy)
    }
}

/// Two fingers on the stage → zoom steps for BrowserZoom (iOS only; the Mac pinches with its
/// trackpad's magnification). Each `move` is one step: the scale change since the last one, the
/// old pinch center to zoom around, and how far the center moved (a two-finger drag pans). Two
/// quick two-finger taps in a row reset the zoom. Driven by explicit points (stage coordinates) and
/// timestamps (ms), like TouchGesture.
public struct BrowserPinch: Sendable {
    public struct Step: Sendable, Equatable {
        public var factor: Double
        public var anchor: Format.Point
        public var dx: Double
        public var dy: Double
        public init(factor: Double, anchor: Format.Point, dx: Double, dy: Double) {
            self.factor = factor
            self.anchor = anchor
            self.dx = dx
            self.dy = dy
        }
    }

    /// Two fingers down and up within this, moving less than `slop` between them, is a tap.
    public var tapMs: Double = 250
    public var slop: Double = 10
    /// A second two-finger tap starting this soon after the first ended resets the zoom.
    public var doubleTapMs: Double = 350

    private var a: Format.Point?
    private var b: Format.Point?
    private var startAt: Double = 0
    private var travel: Double = 0
    private var lastTapAt: Double?

    public init() {}

    public var active: Bool { a != nil }

    public mutating func begin(_ a: Format.Point, _ b: Format.Point, at: Double) {
        self.a = a
        self.b = b
        startAt = at
        travel = 0
    }

    public mutating func move(_ a2: Format.Point, _ b2: Format.Point) -> Step? {
        guard let a, let b else { return nil }
        let d0 = hypot(b.x - a.x, b.y - a.y)
        let d1 = hypot(b2.x - a2.x, b2.y - a2.y)
        let c0 = Format.Point(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        let c1 = Format.Point(x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2)
        travel += hypot(a2.x - a.x, a2.y - a.y) + hypot(b2.x - b.x, b2.y - b.y)
        self.a = a2
        self.b = b2
        return Step(factor: d0 > 0 ? d1 / d0 : 1, anchor: c0, dx: c1.x - c0.x, dy: c1.y - c0.y)
    }

    /// The pinch ended (a finger lifted): true when it was the second of two quick two-finger
    /// taps, so the zoom resets.
    public mutating func end(at: Double) -> Bool {
        guard active else { return false }
        a = nil
        b = nil
        guard at - startAt <= tapMs, travel < slop else {
            lastTapAt = nil
            return false
        }
        if let last = lastTapAt, startAt - last <= doubleTapMs {
            lastTapAt = nil
            return true
        }
        lastTapAt = at
        return false
    }

    /// The system took the touches: no tap, nothing pending.
    public mutating func cancel() {
        a = nil
        b = nil
        lastTapAt = nil
    }
}

/// JS truthiness of a number: NaN and ±0 are falsy.
private func truthy(_ x: Double) -> Bool { x != 0 && !x.isNaN }
