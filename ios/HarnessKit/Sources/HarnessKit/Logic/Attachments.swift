import Foundation

// A port of shared/src/state/attachments.ts (thumbnail boxes, lightbox stepping, the count label),
// plus the iPhone's own layout: thumbnail sizes in the spec, fitting, paging and
// swipe-to-close in the full-screen viewer. Pure layout math: points in, points out.
//
// FileViewer.formatSize and Attachments.formatSize are deliberately different (one keeps
// "3.0 MB", the other reads "3 MB" and promotes 1023.96 KB to "1 MB"), so both exist.

/// The parts of an attachment the layout math reads: its kind, and its pixel size when the
/// service parsed it from the file header.
public struct AttachmentDimensions: Codable, Equatable, Sendable {
    public var kind: AttachmentKind?
    public var width: Double?
    public var height: Double?

    public init(kind: AttachmentKind? = nil, width: Double? = nil, height: Double? = nil) {
        self.kind = kind
        self.width = width
        self.height = height
    }

    public init(_ a: Attachment) {
        self.init(kind: a.kind, width: a.width.map(Double.init), height: a.height.map(Double.init))
    }

    /// Both dimensions known and positive.
    var known: Bool {
        guard let width, let height else { return false }
        return width > 0 && height > 0
    }
}

/// A width and height in points.
public struct AttachmentSize: Codable, Equatable, Sendable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public enum Attachments {
    // MARK: - shared/src/state/attachments.ts

    /// The widest and tallest a thumbnail may be relative to its height, so a panorama or a phone-tall screenshot stays a thumbnail.
    private static let minAspect = 0.5
    private static let maxAspect = 2.5
    /// Unknown dimensions (a video, or an image whose header wasn't parsed) get a 4:3 box.
    private static let defaultAspect = 4.0 / 3.0

    /// The box a thumbnail takes at `height` points tall: its own aspect ratio when the service
    /// knew the dimensions (so nothing shifts when it loads), clamped to 1:2..5:2; 4:3 otherwise.
    public static func thumbnailBox(_ a: AttachmentDimensions, height: Double) -> AttachmentSize {
        let aspect = a.known ? min(maxAspect, max(minAspect, a.width! / a.height!)) : defaultAspect
        return AttachmentSize(width: JSCompat.round(height * aspect), height: height)
    }

    public static func thumbnailBox(_ a: Attachment, height: Double) -> AttachmentSize {
        thumbnailBox(AttachmentDimensions(a), height: height)
    }

    /// The lightbox index after moving `delta` from `index` among `count` attachments, wrapping at both ends.
    public static func stepAttachment(index: Int, delta: Int, count: Int) -> Int {
        if count <= 0 { return 0 }
        return (((index + delta) % count) + count) % count
    }

    /// "2 images", "1 video", "1 image, 2 videos", or "" when there are none. Anything that isn't
    /// an image counts as a video.
    public static func attachmentsLabel(_ kinds: [AttachmentKind]) -> String {
        let images = kinds.filter { $0 == .image }.count
        let videos = kinds.count - images
        func part(_ n: Int, _ word: String) -> String { n == 0 ? "" : "\(n) \(word)\(n == 1 ? "" : "s")" }
        return [part(images, "image"), part(videos, "video")].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    public static func attachmentsLabel(_ list: [Attachment]) -> String {
        attachmentsLabel(list.map(\.kind))
    }

    // MARK: - iPhone layout (frozen fixtures)

    /// Thumbnail row height; widths follow each attachment's aspect ratio within these bounds.
    public struct ThumbMetrics: Codable, Equatable, Sendable {
        public var height: Double
        public var minWidth: Double
        public var maxWidth: Double

        public init(height: Double, minWidth: Double, maxWidth: Double) {
            self.height = height
            self.minWidth = minWidth
            self.maxWidth = maxWidth
        }
    }

    public static let thumb = ThumbMetrics(height: 120, minWidth: 72, maxWidth: 240)

    /// Width / height, when both are known and positive; otherwise a default per kind (video 16:9, image 4:3).
    public static func aspectOf(_ a: AttachmentDimensions) -> Double {
        if a.known { return a.width! / a.height! }
        return a.kind == .video ? 16.0 / 9.0 : 4.0 / 3.0
    }

    /// The thumbnail's box: fixed height, width from the aspect ratio clamped so panoramas and tall shots stay tappable.
    public static func thumbSize(_ a: AttachmentDimensions, metrics t: ThumbMetrics = thumb) -> AttachmentSize {
        let width = JSCompat.round(min(t.maxWidth, max(t.minWidth, t.height * aspectOf(a))))
        return AttachmentSize(width: width, height: t.height)
    }

    public static func thumbSize(_ a: Attachment, metrics t: ThumbMetrics = thumb) -> AttachmentSize {
        thumbSize(AttachmentDimensions(a), metrics: t)
    }

    /// The image's size once fitted inside `box` without upscaling past its own pixels (a small
    /// screenshot stays crisp at 1:1 instead of blowing up). Unknown sizes fill the box.
    public static func fitSize(_ a: AttachmentDimensions, in box: AttachmentSize) -> AttachmentSize {
        if box.width <= 0 || box.height <= 0 { return AttachmentSize(width: 0, height: 0) }
        let ratio = aspectOf(a)
        var width = min(box.width, box.height * ratio)
        if a.known { width = min(width, a.width!) }
        return AttachmentSize(width: JSCompat.round(width), height: JSCompat.round(width / ratio))
    }

    public static func fitSize(_ a: Attachment, in box: AttachmentSize) -> AttachmentSize {
        fitSize(AttachmentDimensions(a), in: box)
    }

    /// A page index kept inside [0, count - 1] (0 when there are no pages).
    public static func clampPage(_ index: Double, count: Int) -> Int {
        if count <= 0 || !index.isFinite { return 0 }
        return Int(min(Double(count - 1), max(0, JSCompat.round(index))))
    }

    /// The page a horizontal pager rests on at `offsetX`.
    public static func pageAt(offsetX: Double, pageWidth: Double, count: Int) -> Int {
        pageWidth > 0 ? clampPage(offsetX / pageWidth, count: count) : 0
    }

    /// Swipe-down-to-close thresholds: a long drag, or a shorter one flicked downward.
    public struct DismissThresholds: Codable, Equatable, Sendable {
        /// Points.
        public var distance: Double
        /// Points.
        public var flickDistance: Double
        /// Points per millisecond.
        public var flickVelocity: Double
    }

    public static let dismiss = DismissThresholds(distance: 120, flickDistance: 40, flickVelocity: 0.8)

    /// Whether a vertical drag released at `dy` (points, down positive) and `vy` (points/ms) closes the viewer.
    public static func shouldDismiss(dy: Double, vy: Double) -> Bool {
        dy >= dismiss.distance || (dy >= dismiss.flickDistance && vy >= dismiss.flickVelocity)
    }

    /// A zoomed page pans instead: its top-edge bounce isn't a pull.
    private static func isZoomed(_ zoomScale: Double) -> Bool { zoomScale > 1.01 }

    /// How far a viewer page is pulled down, from its scroll view's bounce: iOS reports a pull as a
    /// negative content offset. Zero when zoomed or scrolled the other way.
    public static func pullOf(offsetY: Double, zoomScale: Double = 1) -> Double {
        isZoomed(zoomScale) ? 0 : max(0, -offsetY)
    }

    /// Whether letting go of a page closes the viewer. `velocityY` is the scroll view's end-drag
    /// velocity (points/ms, as UIKit's `scrollViewWillEndDragging` reports it; negative while
    /// pulling content down). Convert first if the velocity comes in another unit.
    public static func dismissOnRelease(offsetY: Double, velocityY: Double, zoomScale: Double = 1) -> Bool {
        !isZoomed(zoomScale) && shouldDismiss(dy: pullOf(offsetY: offsetY), vy: -velocityY)
    }

    /// "after.png · 1.2 MB" style sizes. Empty for a negative or non-finite size.
    public static func formatSize(_ bytes: Double) -> String {
        if !bytes.isFinite || bytes < 0 { return "" }
        if bytes < 1024 { return "\(JSCompat.string(bytes)) B" }
        let units = ["KB", "MB", "GB"]
        func round(_ v: Double) -> Double { v >= 10 ? JSCompat.round(v) : JSCompat.round(v * 10) / 10 }
        var v = bytes / 1024
        var u = 0
        // Promote on the rounded value, so 1023.96 KB reads "1 MB" rather than "1024 KB".
        while round(v) >= 1024 && u < units.count - 1 {
            v /= 1024
            u += 1
        }
        return "\(JSCompat.string(round(v))) \(units[u])"
    }
}
