import HarnessHighlight
import HarnessKit
import SwiftUI

// SwiftUI bridge for HarnessHighlight: token lines → AttributedString, styled the way the RN app's
// CodeBlock (mobile/src/ui/CodeBlock.tsx) styles spans. Views that show code (markdown code blocks,
// the file viewer, diffs) build their text with this rather than redoing it.

extension Highlighter {
    /// The app's highlighter, reading highlighter.js from the app bundle ("Bundle highlighter" phase).
    static let app = Highlighter.bundled()
}

enum HighlightedText {
    /// CodeBlock's FONT (12.5 pt) in SF Mono.
    static let fontSize: CGFloat = 12.5
    static let font = Font.system(size: fontSize, design: .monospaced)

    /// How lines draw beyond their spans' own colors.
    struct Style {
        /// The theme's default text color (`Highlighted.fg`, or the app theme's text before colors land)
        var fg: Color
        /// Sign colors for added/removed diff lines (`Highlighted.added`/`.deleted`); nil leaves signs in `fg`.
        var signs: (add: Color, del: Color)?
        /// Hunk and file header lines (CodeBlock draws them in text3); nil draws them in `fg`.
        var meta: Color?
    }

    /// One line as an AttributedString: each span in its color, Shiki's fontStyle bits as italic,
    /// bold and underline. A diff line's first span is its sign, colored by kind; header lines
    /// take `style.meta`.
    static func line(_ line: HighlightedLine, style: Style) -> AttributedString {
        var out = AttributedString()
        let isMeta = line.kind == .hunk || line.kind == .meta
        for (i, span) in line.spans.enumerated() {
            var run = AttributedString(span.text)
            if isMeta {
                run.foregroundColor = style.meta ?? style.fg
            } else if i == 0, let signs = style.signs, line.kind == .add || line.kind == .del {
                run.foregroundColor = line.kind == .add ? signs.add : signs.del
            } else {
                run.foregroundColor = span.color.flatMap { Color(css: $0) } ?? style.fg
                if span.isItalic || span.isBold {
                    run.font = font.weight(span.isBold ? .bold : .regular).italic(span.isItalic)
                }
                if span.isUnderline { run.underlineStyle = .single }
            }
            out.append(run)
        }
        return out
    }

    /// A whole block, lines joined with newlines, so one Text selects and copies all of it.
    static func block(_ lines: [HighlightedLine], style: Style) -> AttributedString {
        var out = AttributedString()
        for (i, l) in lines.enumerated() {
            if i > 0 { out.append(AttributedString("\n")) }
            out.append(line(l, style: style))
        }
        return out
    }

    /// The style for a highlight result, or for plain lines (`highlighted` nil) in an app theme.
    static func style(_ highlighted: Highlighted?, tokens: ThemeTokens, appearance: ThemeAppearance) -> Style {
        let git = highlighted?.git ?? HighlightColors.gitColors(nil, appearance)
        return Style(
            fg: highlighted.flatMap { Color(css: $0.fg) } ?? tokens.color(.text),
            signs: (Color(css: git.added) ?? .green, Color(css: git.deleted) ?? .red),
            meta: tokens.color(.text3)
        )
    }
}
