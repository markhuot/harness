import Foundation

/// One layer of a CSS `box-shadow` list, as the theme shadow tokens write them:
/// `[inset] <x> <y> [blur] [spread] [color]` with lengths in px (or a bare 0).
/// The reference parser (and its fixtures) is in shared/fixtures/cases/themes.ts.
public struct BoxShadow: Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var blur: Double
    public var spread: Double
    /// nil when the layer names no color (CSS currentColor).
    public var color: RGBA?
    public var inset: Bool

    public init(x: Double, y: Double, blur: Double = 0, spread: Double = 0, color: RGBA? = nil, inset: Bool = false) {
        self.x = x
        self.y = y
        self.blur = blur
        self.spread = spread
        self.color = color
        self.inset = inset
    }

    /// Every layer of a box-shadow list, or nil when any layer isn't one this understands.
    public static func parseList(_ css: String) -> [BoxShadow]? {
        var layers = [BoxShadow]()
        for layer in splitLayers(css) {
            guard let l = parseLayer(layer) else { return nil }
            layers.append(l)
        }
        return layers
    }

    /// The first (topmost) layer of a box-shadow list, or nil when the list doesn't parse.
    public static func parse(_ css: String) -> BoxShadow? {
        parseList(css)?.first
    }

    // MARK: - Internals

    static func splitLayers(_ s: String) -> [String] {
        var out = [String]()
        var depth = 0
        var cur = String.UnicodeScalarView()
        for ch in s.unicodeScalars {
            if ch == "(" { depth += 1 } else if ch == ")" { depth = max(0, depth - 1) }
            if ch == ",", depth == 0 {
                out.append(String(cur))
                cur = String.UnicodeScalarView()
            } else {
                cur.append(ch)
            }
        }
        out.append(String(cur))
        return out
    }

    /// `layer.match(/[a-z]+\([^)]*\)|[^\s]+/gi)`
    static func tokens(_ layer: String) -> [String] {
        let s = Array(layer.unicodeScalars)
        func isLetter(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("A"..."Z").contains(c) }
        var out = [String]()
        var i = 0
        while i < s.count {
            if JSCompat.isWhitespace(s[i]) {
                i += 1
                continue
            }
            var end: Int?
            if isLetter(s[i]) {
                var j = i
                while j < s.count, isLetter(s[j]) { j += 1 }
                if j < s.count, s[j] == "(", let close = s[(j + 1)...].firstIndex(of: ")") { end = close + 1 }
            }
            if end == nil {
                var j = i
                while j < s.count, !JSCompat.isWhitespace(s[j]) { j += 1 }
                end = j
            }
            out.append(String(String.UnicodeScalarView(s[i..<end!])))
            i = end!
        }
        return out
    }

    /// /^(-?)(\d+(?:\.\d+)?|\.\d+)(px)?$/ → (value, hasUnit)
    static func length(_ tok: String) -> (Double, Bool)? {
        var body = Substring(tok)
        let unit = body.hasSuffix("px")
        if unit { body = body.dropLast(2) }
        var digits = body
        if digits.hasPrefix("-") { digits = digits.dropFirst() }
        let parts = digits.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let isDigits = { (p: Substring) in !p.isEmpty && p.allSatisfy { $0.isASCII && $0.isNumber } }
        let ok = parts.count == 1 ? isDigits(parts[0]) : (parts[0].isEmpty || isDigits(parts[0])) && isDigits(parts[1])
        guard ok, let v = Double(body) else { return nil }
        return (v == 0 ? 0 : v, unit)
    }

    static func parseLayer(_ layer: String) -> BoxShadow? {
        var inset = false
        var color: RGBA?
        var lengths = [Double]()
        var lengthsDone = false
        for tok in tokens(layer) {
            if tok.lowercased() == "inset" {
                if inset { return nil }
                inset = true
                if !lengths.isEmpty { lengthsDone = true }
                continue
            }
            if let (n, unit) = length(tok) {
                if !unit, n != 0 { return nil }
                if lengthsDone { return nil }
                lengths.append(n)
                continue
            }
            if let c = RGBA(css: tok) {
                if color != nil { return nil }
                color = c
                if !lengths.isEmpty { lengthsDone = true }
                continue
            }
            return nil
        }
        guard (2...4).contains(lengths.count) else { return nil }
        let blur = lengths.count > 2 ? lengths[2] : 0
        let spread = lengths.count > 3 ? lengths[3] : 0
        if blur < 0 { return nil }
        return BoxShadow(x: lengths[0], y: lengths[1], blur: blur, spread: spread, color: color, inset: inset)
    }
}
