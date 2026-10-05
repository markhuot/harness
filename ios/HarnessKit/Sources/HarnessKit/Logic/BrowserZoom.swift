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
}

/// JS truthiness of a number: NaN and ±0 are falsy.
private func truthy(_ x: Double) -> Bool { x != 0 && !x.isNaN }
