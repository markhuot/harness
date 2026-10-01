import Foundation

/// JavaScript's `Number(string)` (ECMAScript StringToNumber), for form fields the RN app parses
/// with `Number(…)`. Swift's `Double(String)` accepts things JS doesn't ("inf", "nan", "0x1p3")
/// and rejects things it does (" 12 ", "", "0b101"), so the grammar is checked here first.
enum JSNumber {
    /// `Number(s)`: JS-trimmed; "" → 0; `0x`/`0o`/`0b` integers (unsigned); `[+-]Infinity`;
    /// decimal literals (`5.`, `.5`, `1e+2`); anything else → NaN.
    static func parse(_ s: String) -> Double {
        let scalars = Array(JSCompat.trim(s).unicodeScalars)
        if scalars.isEmpty { return 0 }
        if scalars.count > 2, scalars[0] == "0" {
            switch scalars[1] {
            case "x", "X": return radix(scalars.dropFirst(2), bits: 4)
            case "o", "O": return radix(scalars.dropFirst(2), bits: 3)
            case "b", "B": return radix(scalars.dropFirst(2), bits: 1)
            default: break
            }
        }
        var body = scalars[...]
        var sign = 1.0
        if let f = body.first, f == "+" || f == "-" {
            if f == "-" { sign = -1 }
            body = body.dropFirst()
        }
        if String(String.UnicodeScalarView(body)) == "Infinity" { return sign * .infinity }
        guard isDecimalLiteral(body), let v = Double(String(String.UnicodeScalarView(scalars))) else { return .nan }
        return v
    }

    /// StrUnsignedDecimalLiteral: `digits [. digits?]`, or `. digits`, then an optional `e[+-]digits`.
    static func isDecimalLiteral(_ s: ArraySlice<Unicode.Scalar>) -> Bool {
        var i = s.startIndex
        func digits() -> Int {
            let start = i
            while i < s.endIndex, ("0"..."9").contains(s[i]) { i += 1 }
            return i - start
        }
        var mantissa = digits()
        if i < s.endIndex, s[i] == "." {
            i += 1
            mantissa += digits()
        }
        guard mantissa > 0 else { return false }
        if i < s.endIndex, s[i] == "e" || s[i] == "E" {
            i += 1
            if i < s.endIndex, s[i] == "+" || s[i] == "-" { i += 1 }
            guard digits() > 0 else { return false }
        }
        return i == s.endIndex
    }

    /// A `0x`/`0o`/`0b` literal's digits, correctly rounded to a Double (as JS does): the leading
    /// digits go into a UInt64, any further nonzero digit sets a sticky low bit (which sits below the
    /// rounding position, so ties break the right way), then the result is scaled by 2^(bits·rest).
    static func radix(_ digits: ArraySlice<Unicode.Scalar>, bits: Int) -> Double {
        var value: UInt64 = 0
        var rest = 0
        var sticky = false
        for c in digits {
            guard let d = digitValue(c), d < (1 << bits) else { return .nan }
            if value >> (64 - bits) == 0 {
                value = value << bits | UInt64(d)
            } else {
                rest += 1
                if d != 0 { sticky = true }
            }
        }
        if sticky { value |= 1 }
        return Double(value) * pow(2, Double(bits * rest))
    }

    static func digitValue(_ c: Unicode.Scalar) -> Int? {
        switch c {
        case "0"..."9": Int(c.value - 0x30)
        case "a"..."f": Int(c.value - 0x61 + 10)
        case "A"..."F": Int(c.value - 0x41 + 10)
        default: nil
        }
    }
}
