import Foundation

// The few JavaScript semantics the theme ports depend on, so Swift agrees with the TS byte for byte:
// what `String.prototype.trim` and regex `\s` count as whitespace, `Math.round`, and how a number
// prints inside a template literal (`${0.1 + 0.2}`, `${1e-7}`).
enum JSCompat {
    /// ECMAScript WhiteSpace + LineTerminator (the set `trim()` strips and `\s` matches).
    /// U+0085 (NEL) is deliberately absent: JS doesn't treat it as whitespace.
    static func isWhitespace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            true
        default:
            false
        }
    }

    /// `String.prototype.trim()`.
    static func trim(_ s: String) -> String {
        var scalars = Substring(s).unicodeScalars[...]
        while let f = scalars.first, isWhitespace(f) { scalars.removeFirst() }
        while let l = scalars.last, isWhitespace(l) { scalars.removeLast() }
        return String(String.UnicodeScalarView(scalars))
    }

    /// `Math.round`: halves round toward +∞ (-0.5 → -0, 2.5 → 3), exact for values just under a half.
    static func round(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        let f = x.rounded(.down)
        return x - f >= 0.5 ? f + 1 : f
    }

    /// `String(n)` / `${n}` for a JS number (Number::toString, radix 10).
    static func string(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        if x == 0 { return "0" }
        if x.isInfinite { return x < 0 ? "-Infinity" : "Infinity" }
        if x < 0 { return "-" + string(-x) }
        // Swift's description is the shortest round-tripping digit string, as JS requires; only
        // the layout differs, so re-lay it out by the ECMAScript rules.
        let desc = x.description
        let parts = desc.split(separator: "e", maxSplits: 1)
        var exponent = parts.count == 2 ? Int(parts[1])! : 0
        let mantissa = parts[0]
        let intPart = mantissa.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)[0]
        var digits = Array(mantissa.replacingOccurrences(of: ".", with: ""))
        exponent += intPart.count // n: where the decimal point sits relative to the digits
        while digits.first == "0" { digits.removeFirst(); exponent -= 1 }
        while digits.last == "0" { digits.removeLast() }
        let k = digits.count
        let n = exponent
        let d = String(digits)
        if k <= n && n <= 21 { return d + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 { return String(digits[0..<n]) + "." + String(digits[n...]) }
        if -6 < n && n <= 0 { return "0." + String(repeating: "0", count: -n) + d }
        let e = n - 1
        let sign = e < 0 ? "-" : "+"
        let head = k == 1 ? d : String(digits[0]) + "." + String(digits[1...])
        return head + "e" + sign + String(abs(e))
    }
}
