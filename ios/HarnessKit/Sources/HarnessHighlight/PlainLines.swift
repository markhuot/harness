import Foundation

// plainLines and reuseLines from mobile/src/lib/highlight.ts: what a block shows before (or without)
// its colors, synchronously, so a view never waits on the highlighter to draw text.

public enum PlainLines {
    /// A block's lines before (or without) highlighting: one uncolored span each, diff kinds included.
    /// Code lines of a diff keep their sign as a span of its own, as `diffLines` does.
    public static func lines(_ code: String, diff: Bool) -> [HighlightedLine] {
        guard diff else {
            return code.components(separatedBy: "\n").map { HighlightedLine(spans: [HighlightSpan(text: $0)]) }
        }
        return diffKinds(code).map { kind, text in
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

    // MARK: - Line kinds (shared/src/diff.ts parseDiff, kinds only)

    // TODO(dedupe): HARNESS-132 ports parseDiff in full to HarnessKit; switch to it once both land.

    private static let hunk = try! NSRegularExpression(pattern: "^@@ -([0-9]+)(?:,([0-9]+))? \\+([0-9]+)(?:,([0-9]+))? @@")
    private static let headers = ["diff ", "index ", "new file", "deleted file", "similarity ", "dissimilarity ", "rename ", "copy ", "old mode", "new mode", "Binary files"]

    private static func starts(_ s: String, _ prefix: String) -> Bool {
        s.unicodeScalars.starts(with: prefix.unicodeScalars)
    }

    /// Each line's kind as parseDiff classifies it. File paths only pick languages, and `diff --git`
    /// lines are headers either way, so this skips the file bookkeeping.
    static func diffKinds(_ text: String) -> [(HighlightLineKind, String)] {
        let src = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var out: [(HighlightLineKind, String)] = []
        var oldLeft = 0.0
        var newLeft = 0.0
        var i = 0
        while i < src.count {
            defer { i += 1 }
            let l = src[i]
            let inHunk = oldLeft > 0 || newLeft > 0
            if !inHunk {
                if starts(l, "--- "), i + 1 < src.count, starts(src[i + 1], "+++ ") {
                    out.append((.meta, l))
                    i += 1
                    out.append((.meta, src[i]))
                    continue
                }
                if headers.contains(where: { starts(l, $0) }) || starts(l, "\\") {
                    out.append((.meta, l))
                    continue
                }
            }
            let ns = l as NSString
            if let m = hunk.firstMatch(in: l, range: NSRange(location: 0, length: ns.length)) {
                func count(_ g: Int) -> Double {
                    let r = m.range(at: g)
                    return r.location == NSNotFound ? 1 : Double(ns.substring(with: r)) ?? 1
                }
                oldLeft = count(2)
                newLeft = count(4)
                out.append((.hunk, l))
                continue
            }
            if !inHunk, starts(l, "@@") {
                oldLeft = 0
                newLeft = 0
                out.append((.hunk, l))
                continue
            }
            switch l.unicodeScalars.first {
            case "+":
                newLeft = max(0, newLeft - 1)
                out.append((.add, l))
            case "-":
                oldLeft = max(0, oldLeft - 1)
                out.append((.del, l))
            case "\\":
                out.append((.meta, l))
            default:
                oldLeft = max(0, oldLeft - 1)
                newLeft = max(0, newLeft - 1)
                out.append((.ctx, l))
            }
        }
        return out
    }
}
