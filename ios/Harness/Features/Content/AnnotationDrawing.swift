import HarnessKit
import SwiftUI
import UIKit

/// Draws annotation marks (HarnessKit Annotations) into a Core Graphics context: one function for
/// the annotator's overlay, the marks over an annotated attachment's thumbnail, and over the image
/// in the full-screen viewer, so an annotation looks the same everywhere. The image itself is never
/// changed: the marks are metadata on the attachment (PromptAttachment.annotation), drawn on top.
/// Each mark is an accent arrow with a white outline from its badge to its anchor (when it has a
/// tail far enough away), then a filled accent badge with a white outline and its white number.
/// Later marks draw over earlier ones, as hitTest expects.
enum AnnotationDrawing {
    /// `marks` over a `size` surface (points of the context), styled for that surface.
    nonisolated static func draw(_ marks: [Annotations.DraftMark], in cg: CGContext, size: CGSize, accent: UIColor, style: Annotations.Style? = nil) {
        let style = style ?? Annotations.style(width: size.width, height: size.height)
        for (i, m) in marks.enumerated() {
            draw(m, number: i + 1, in: cg, size: size, style: style, accent: accent)
        }
    }

    nonisolated static func draw(_ m: Annotations.DraftMark, number: Int, in cg: CGContext, size: CGSize, style: Annotations.Style, accent: UIColor) {
        let w = size.width, h = size.height
        let anchor = Annotations.toSurface(m.anchor, width: w, height: h)
        let badge = Annotations.toSurface(Annotations.badgeCenter(m), width: w, height: h)
        cg.saveGState()
        defer { cg.restoreGState() }
        cg.setLineCap(.round)
        cg.setLineJoin(.round)
        if let tail = m.tail, let arrow = Annotations.arrowGeometry(tail: Annotations.toSurface(tail, width: w, height: h), anchor: anchor, style: style) {
            let line = CGMutablePath()
            line.move(to: cgPoint(arrow.line.0))
            line.addLine(to: cgPoint(arrow.line.1))
            let head = CGMutablePath()
            head.move(to: cgPoint(arrow.head.0))
            head.addLine(to: cgPoint(arrow.head.1))
            head.addLine(to: cgPoint(arrow.head.2))
            head.closeSubpath()
            // The white outline first, under the accent.
            cg.setStrokeColor(UIColor.white.cgColor)
            cg.setLineWidth(style.lineWidth + style.outline * 2)
            cg.addPath(line)
            cg.strokePath()
            cg.addPath(head)
            cg.strokePath()
            cg.setStrokeColor(accent.cgColor)
            cg.setLineWidth(style.lineWidth)
            cg.addPath(line)
            cg.strokePath()
            cg.setFillColor(accent.cgColor)
            cg.addPath(head)
            cg.fillPath()
        }
        // The badge: white ring, accent disc, white number.
        let r = style.badgeRadius
        let outer = CGRect(x: badge.x - r - style.outline, y: badge.y - r - style.outline, width: (r + style.outline) * 2, height: (r + style.outline) * 2)
        cg.setFillColor(UIColor.white.cgColor)
        cg.fillEllipse(in: outer)
        cg.setFillColor(accent.cgColor)
        cg.fillEllipse(in: CGRect(x: badge.x - r, y: badge.y - r, width: r * 2, height: r * 2))
        let label = NSAttributedString(string: "\(number)", attributes: [
            .font: UIFont.systemFont(ofSize: number > 9 ? style.fontSize * 0.82 : style.fontSize, weight: .bold),
            .foregroundColor: UIColor.white,
        ])
        let text = label.size()
        UIGraphicsPushContext(cg)
        label.draw(at: CGPoint(x: badge.x - text.width / 2, y: badge.y - text.height / 2))
        UIGraphicsPopContext()
    }

    private nonisolated static func cgPoint(_ p: Annotations.Point) -> CGPoint { CGPoint(x: p.x, y: p.y) }

    /// The marks' style in a thumbnail `side` points across: a fixed share of the box rather than
    /// of the image, so a big screenshot's marks don't shrink to nothing and a small one's don't
    /// fill the box. The Mac app's thumbnailStyle.
    static func thumbnailStyle(side: CGFloat) -> Annotations.Style {
        Annotations.Style(badgeRadius: side * 0.17, fontSize: side * 0.22, lineWidth: side * 0.05, outline: side * 0.03, headLength: side * 0.16, headHalfWidth: side * 0.09)
    }

    /// Where an `image`-sized picture lands when it covers a `box` (scaledToFill, centered).
    static func coverRect(box: CGSize, image: CGSize) -> CGRect {
        guard image.width > 0, image.height > 0 else { return CGRect(origin: .zero, size: box) }
        let k = max(box.width / image.width, box.height / image.height)
        let w = image.width * k, h = image.height * k
        return CGRect(x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h)
    }

    /// A copy of `image` with `annotation`'s marks drawn over it, for the full-screen viewer to show
    /// (and zoom) in its place. Only on screen: the file stays as it is. The marks are styled as the
    /// annotator drew them over the image fitted into `fit` points, scaled to the image's pixels, so
    /// at fit they look as they did there. nil when the image has no size.
    nonisolated static func overlaid(_ image: UIImage, annotation: AttachmentAnnotation, fit: CGSize, accent: UIColor) -> UIImage? {
        let px = pixelSize(image)
        guard px.width > 0, px.height > 0, fit.width > 0, fit.height > 0 else { return nil }
        let k = min(fit.width / px.width, fit.height / px.height, 1)
        let shown = Annotations.style(width: px.width * k, height: px.height * k)
        let s = 1 / k
        let style = Annotations.Style(
            badgeRadius: shown.badgeRadius * s, fontSize: shown.fontSize * s, lineWidth: shown.lineWidth * s,
            outline: shown.outline * s, headLength: shown.headLength * s, headHalfWidth: shown.headHalfWidth * s)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        return UIGraphicsImageRenderer(size: px, format: format).image { ctx in
            image.draw(in: CGRect(origin: .zero, size: px))
            draw(Annotations.draftMarks(from: annotation), in: ctx.cgContext, size: px, accent: accent, style: style)
        }
    }

    /// The image's size in pixels (its points times its scale, orientation applied).
    nonisolated static func pixelSize(_ image: UIImage) -> CGSize {
        CGSize(width: (image.size.width * image.scale).rounded(), height: (image.size.height * image.scale).rounded())
    }
}

/// The marks over the image on screen, drawn with AnnotationDrawing in a SwiftUI Canvas sized to
/// the image's displayed rect.
struct AnnotationOverlay: View {
    let marks: [Annotations.DraftMark]
    let accent: Color

    var body: some View {
        Canvas { ctx, size in
            ctx.withCGContext { cg in
                AnnotationDrawing.draw(marks, in: cg, size: size, accent: UIColor(accent))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// An attachment's annotation over its thumbnail (a row's square, scaledToFill): the marks where
/// they sit on the covered image, in the thumbnail's own style.
struct AnnotationThumbnailOverlay: View {
    let annotation: AttachmentAnnotation
    let accent: Color

    var body: some View {
        Canvas { ctx, size in
            let rect = AnnotationDrawing.coverRect(box: size, image: CGSize(width: annotation.width, height: annotation.height))
            ctx.withCGContext { cg in
                cg.translateBy(x: rect.minX, y: rect.minY)
                AnnotationDrawing.draw(Annotations.draftMarks(from: annotation), in: cg, size: rect.size, accent: UIColor(accent),
                                       style: AnnotationDrawing.thumbnailStyle(side: min(size.width, size.height)))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
