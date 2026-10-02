import Foundation

// Port of shared/src/themes/color.ts: parse #hex / rgb() / rgba(), mix, alpha, WCAG 2.x contrast and
// OKLab distance. Pure. Every function that takes a CSS color string throws CSSColorError where the
// TS throws, and accepts exactly what parseColor accepts.

/// An sRGB triple in 0...255, unclamped and unrounded (`rgb(300, 0, 0)` keeps 300, as in TS).
public struct RGB: Hashable, Sendable {
    public var r: Double
    public var g: Double
    public var b: Double

    public init(_ r: Double, _ g: Double, _ b: Double) {
        self.r = r
        self.g = g
        self.b = b
    }

    var channels: [Double] { [r, g, b] }
}

/// A parsed CSS color: channels in 0...255 and alpha (1 when not given), both as written.
/// A channel spelled like `1.2.3` passes the TS regex but is NaN, and is kept as NaN here too.
public struct RGBA: Hashable, Sendable {
    public var rgb: RGB
    public var a: Double

    public init(rgb: RGB, a: Double = 1) {
        self.rgb = rgb
        self.a = a
    }

    public init(r: Double, g: Double, b: Double, a: Double = 1) {
        self.init(rgb: RGB(r, g, b), a: a)
    }

    /// nil when `css` isn't a color parseColor accepts.
    public init?(css: String) {
        guard let c = try? CSSColor.parse(css) else { return nil }
        self = c
    }

    public var r: Double { rgb.r }
    public var g: Double { rgb.g }
    public var b: Double { rgb.b }
}

public struct CSSColorError: Error, Equatable, CustomStringConvertible {
    public let input: String
    public var description: String { "unparseable color: \(input)" }
}

public enum CSSColor {
    /// `parseColor`: "#rgb", "#rgba", "#rrggbb", "#rrggbbaa", "rgb(r, g, b)" or "rgba(r, g, b, a)"
    /// (either name with three or four arguments), after a JS `trim()`. Throws on anything else.
    public static func parse(_ input: String) throws(CSSColorError) -> RGBA {
        let s = Array(JSCompat.trim(input).unicodeScalars)
        if let c = parseHex(s) ?? parseFunction(s) { return c }
        throw CSSColorError(input: input)
    }

    /// `isColor`.
    public static func isColor(_ input: String) -> Bool {
        (try? parse(input)) != nil
    }

    /// `toHex`: each channel rounded (JS Math.round) and clamped to 0...255.
    public static func toHex(_ rgb: RGB) -> String {
        "#" + rgb.channels.map(hex2).joined()
    }

    /// `over`: composite a (possibly translucent) color over a backdrop (itself composited over white).
    public static func over(_ fg: String, _ backdrop: String) throws(CSSColorError) -> RGB {
        let f = try parse(fg)
        let b = try composite(backdrop)
        return RGB(f.r * f.a + b.r * (1 - f.a), f.g * f.a + b.g * (1 - f.a), f.b * f.a + b.b * (1 - f.a))
    }

    /// `mix`: `amount` of `b` mixed into `a` in sRGB (CSS color-mix(in srgb, a, b amount)), as #hex.
    public static func mix(_ a: String, _ b: String, _ amount: Double) throws(CSSColorError) -> String {
        let x = try composite(a)
        let y = try composite(b)
        return toHex(RGB(x.r + (y.r - x.r) * amount, x.g + (y.g - x.g) * amount, x.b + (y.b - x.b) * amount))
    }

    /// `alpha`: "rgba(r, g, b, a)" formatted like the hand-written tokens (a printed as JS prints it).
    public static func alpha(_ c: String, _ a: Double) throws(CSSColorError) -> String {
        let x = try composite(c)
        let ch = x.channels.map { JSCompat.string(clamp($0)) }
        return "rgba(\(ch[0]), \(ch[1]), \(ch[2]), \(JSCompat.string(a)))"
    }

    /// `luminance`: WCAG 2.x relative luminance.
    public static func luminance(_ rgb: RGB) -> Double {
        0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
    }

    /// `contrast`: WCAG 2.x contrast ratio. Translucent colors composite: fg over bg, bg over white.
    public static func contrast(_ fg: String, _ bg: String) throws(CSSColorError) -> Double {
        let b = try composite(bg)
        let f = try over(fg, toHex(b))
        let (l1, l2) = (luminance(f), luminance(b))
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    /// `oklab`: OKLab (L, a, b) of a color (translucent ones composited over white).
    public static func oklab(_ c: String) throws(CSSColorError) -> [Double] {
        let p = try composite(c)
        let r = channel(p.r), g = channel(p.g), b = channel(p.b)
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return [
            0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
        ]
    }

    /// `distance`: Euclidean distance in OKLab.
    public static func distance(_ a: String, _ b: String) throws(CSSColorError) -> Double {
        let x = try oklab(a)
        let y = try oklab(b)
        return hypot(hypot(x[0] - y[0], x[1] - y[1]), x[2] - y[2])
    }

    /// `readable`: `color` nudged toward `toward` in 1/50 steps only as far as needed to reach `min`
    /// contrast on every backdrop; unchanged when it already passes, `toward` when nothing does.
    public static func readable(_ color: String, backdrops: [String], min: Double, toward: String) throws(CSSColorError) -> String {
        for step in 0...50 {
            let c = step == 0 ? color : try mix(color, toward, Double(step) / 50)
            var ok = true
            for b in backdrops where try contrast(c, b) < min {
                ok = false
                break
            }
            if ok { return c }
        }
        return toward
    }

    // MARK: - Internals

    /// An opaque color's RGB; a translucent one is composited over white, like an unpainted page.
    static func composite(_ c: String) throws(CSSColorError) -> RGB {
        let p = try parse(c)
        if p.a >= 1 { return p.rgb }
        return RGB(p.r * p.a + 255 * (1 - p.a), p.g * p.a + 255 * (1 - p.a), p.b * p.a + 255 * (1 - p.a))
    }

    /// `Math.max(0, Math.min(255, Math.round(n)))`, NaN staying NaN as in JS.
    static func clamp(_ n: Double) -> Double {
        let r = JSCompat.round(n)
        if r.isNaN { return r }
        return Swift.max(0, Swift.min(255, r))
    }

    static func hex2(_ n: Double) -> String {
        let c = clamp(n)
        guard !c.isNaN else { return "NaN" }
        let s = String(Int(c), radix: 16)
        return s.count < 2 ? "0" + s : s
    }

    static func channel(_ v: Double) -> Double {
        let s = v / 255
        return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
    }

    static func hexValue(_ s: Unicode.Scalar) -> Int? {
        switch s.value {
        case 0x30...0x39: Int(s.value - 0x30)
        case 0x61...0x66: Int(s.value - 0x61 + 10)
        case 0x41...0x46: Int(s.value - 0x41 + 10)
        default: nil
        }
    }

    /// /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
    static func parseHex(_ s: [Unicode.Scalar]) -> RGBA? {
        guard s.first == "#", [4, 5, 7, 9].contains(s.count) else { return nil }
        var v = [Int]()
        for x in s.dropFirst() {
            guard let h = hexValue(x) else { return nil }
            v.append(h)
        }
        if v.count <= 4 { v = v.flatMap { [$0, $0] } }
        let n = { (i: Int) in Double(v[i] * 16 + v[i + 1]) }
        return RGBA(rgb: RGB(n(0), n(2), n(4)), a: v.count == 8 ? n(6) / 255 : 1)
    }

    /// /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i
    /// (`\d` is ASCII-only and `\s` is JS whitespace; the classes are disjoint, so a greedy scan
    /// matches exactly what the regex does.)
    static func parseFunction(_ s: [Unicode.Scalar]) -> RGBA? {
        var i = 0
        func lower(_ x: Unicode.Scalar) -> Unicode.Scalar {
            (0x41...0x5A).contains(x.value) ? Unicode.Scalar(x.value + 0x20)! : x
        }
        func eat(_ c: Unicode.Scalar) -> Bool {
            guard i < s.count, lower(s[i]) == c else { return false }
            i += 1
            return true
        }
        func skipSpace() { while i < s.count, JSCompat.isWhitespace(s[i]) { i += 1 } }
        func number() -> Double? {
            let start = i
            while i < s.count, s[i] == "." || ("0"..."9").contains(s[i]) { i += 1 }
            guard i > start else { return nil }
            return jsNumber(String(String.UnicodeScalarView(s[start..<i])))
        }
        guard eat("r"), eat("g"), eat("b") else { return nil }
        _ = eat("a")
        guard eat("(") else { return nil }
        var values = [Double]()
        for k in 0..<4 {
            if k > 0 {
                guard eat(",") else {
                    if k == 3 { break }
                    return nil
                }
            }
            skipSpace()
            guard let n = number() else { return nil }
            values.append(n)
            skipSpace()
        }
        guard eat(")"), i == s.count else { return nil }
        return RGBA(rgb: RGB(values[0], values[1], values[2]), a: values.count == 4 ? values[3] : 1)
    }

    /// `Number(s)` for a string of ASCII digits and dots: NaN unless it's one decimal literal.
    static func jsNumber(_ s: String) -> Double {
        guard s.filter({ $0 == "." }).count <= 1, s.contains(where: \.isASCIIDigitCharacter) else { return .nan }
        return Double(s) ?? .nan
    }
}

extension Character {
    fileprivate var isASCIIDigitCharacter: Bool { isASCII && isNumber }
}
