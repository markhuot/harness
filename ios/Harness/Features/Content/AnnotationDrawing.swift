import HarnessKit
import SwiftUI
import UIKit

/// Draws annotation marks (HarnessKit Annotations) into a Core Graphics context: one function for
/// both the annotator's on-screen overlay and the composite sent to the agent, so what goes out
/// looks like what was on screen. Each mark is an accent arrow with a white outline from its badge
/// to its anchor (when it has a tail far enough away), then a filled accent badge with a white
/// outline and its white number. Later marks draw over earlier ones, as hitTest expects.
enum AnnotationDrawing {
    /// `marks` over a `size` surface (points of the context), styled for that surface.
    static func draw(_ marks: [Annotations.DraftMark], in cg: CGContext, size: CGSize, accent: UIColor) {
        let style = Annotations.style(width: size.width, height: size.height)
        for (i, m) in marks.enumerated() {
            draw(m, number: i + 1, in: cg, size: size, style: style, accent: accent)
        }
    }

    static func draw(_ m: Annotations.DraftMark, number: Int, in cg: CGContext, size: CGSize, style: Annotations.Style, accent: UIColor) {
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

    private static func cgPoint(_ p: Annotations.Point) -> CGPoint { CGPoint(x: p.x, y: p.y) }

    /// The image with `marks` burned in at its own pixel size, encoded as PNG, or as JPEG when the
    /// PNG is over the inline limit (Annotations.encodeWithinLimit). nil when it couldn't be encoded.
    static func composite(_ image: UIImage, marks: [Annotations.DraftMark], accent: UIColor) -> (data: Data, jpeg: Bool, width: Double, height: Double)? {
        let size = pixelSize(image)
        guard size.width > 0, size.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let out = renderer.image { ctx in
            image.draw(in: CGRect(origin: .zero, size: size))
            draw(marks, in: ctx.cgContext, size: size, accent: accent)
        }
        guard let encoded = Annotations.encodeWithinLimit({ q in
            if let q { out.jpegData(compressionQuality: q) } else { out.pngData() }
        }) else { return nil }
        return (encoded.data, encoded.jpeg, size.width, size.height)
    }

    /// The image's size in pixels (its points times its scale, orientation applied).
    static func pixelSize(_ image: UIImage) -> CGSize {
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
