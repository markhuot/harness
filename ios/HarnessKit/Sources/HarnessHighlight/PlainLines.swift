import Foundation
import HarnessKit

// plainLines and reuseLines from mobile/src/lib/highlight.ts: what a block shows before (or without)
// its colors, synchronously, so a view never waits on the highlighter to draw text.

public enum PlainLines {
    /// A block's lines before (or without) highlighting: one uncolored span each, diff kinds included.
    /// Code lines of a diff keep their sign as a span of its own, as `diffLines` does.
    public static func lines(_ code: String, diff: Bool) -> [HighlightedLine] {
        guard diff else {
            return code.components(separatedBy: "\n").map { HighlightedLine(spans: [HighlightSpan(text: $0)]) }
        }
        return Diff.parseDiff(code).lines.map { l in
            let (kind, text) = (l.kind, l.text)
            switch kind {
            case .add, .del, .ctx:
                let (sign, rest) = splitSign(text)
                return HighlightedLine(spans: [HighlightSpan(text: sign), HighlightSpan(text: rest)], kind: kind)
            case .hunk, .meta:
                return HighlightedLine(spans: [HighlightSpan(text: text)], kind: kind)
            }
        }
    }

    /// While a changed block (a message still streaming in) is re-highlighted, keep the colors of
    /// every line whose text and kind didn't change, instead of flashing the whole block plain.
    public static func reuse(_ plain: [HighlightedLine], _ prev: [HighlightedLine]?) -> [HighlightedLine] {
        guard let prev else { return plain }
        return plain.enumerated().map { i, l in
            guard i < prev.count else { return l }
            let p = prev[i]
            return p.kind == l.kind && p.text == l.text ? p : l
        }
    }

    /// `text.slice(0, 1)` / `text.slice(1)`. When the first character is astral (two UTF-16 units)
    /// the sign is empty and the character stays whole, as the bundle's wellFormed() leaves it.
    static func splitSign(_ text: String) -> (String, String) {
        guard let first = text.unicodeScalars.first else { return ("", "") }
        if first.utf16.count > 1 { return ("", text) }
        return (String(first), String(text.unicodeScalars.dropFirst()))
    }
}
