import Foundation
import Testing
@testable import HarnessKit

/// parseColor's output as JSON writes it: NaN channels become null.
struct RGBAOutput: Decodable, Sendable, Equatable {
    let rgb: [Double?]
    let a: Double?

    init(rgb: [Double?], a: Double?) {
        self.rgb = rgb
        self.a = a
    }

    init(_ c: RGBA) {
        let n = { (d: Double) -> Double? in d.isNaN ? nil : d }
        self.init(rgb: [n(c.r), n(c.g), n(c.b)], a: n(c.a))
    }
}

/// Floating results can differ from JS in the last bit (libm cbrt/pow/hypot), never more.
func approxEqual(_ a: Double, _ b: Double, tolerance: Double = 1e-12) -> Bool {
    if a == b { return true }
    return abs(a - b) <= tolerance * max(1, abs(a), abs(b))
}

func approxEqual(_ a: [Double], _ b: [Double]) -> Bool {
    a.count == b.count && zip(a, b).allSatisfy { approxEqual($0, $1) }
}

struct OverInput: Decodable, Sendable { let fg: String; let backdrop: String }
struct MixInput: Decodable, Sendable { let a: String; let b: String; let amount: Double }
struct AlphaInput: Decodable, Sendable { let c: String; let a: Double }
struct ContrastInput: Decodable, Sendable { let fg: String; let bg: String }
struct DistanceInput: Decodable, Sendable { let a: String; let b: String }
struct ReadableInput: Decodable, Sendable { let color: String; let backdrops: [String]; let min: Double; let toward: String }

private func rgb(_ v: [Double]) -> RGB { RGB(v[0], v[1], v[2]) }

@Suite("themes/color.ts parity")
struct ThemeColorTests {
    @Test(arguments: Fixture.cases("color", "parseColorCases", input: String.self, output: RGBAOutput?.self))
    func parseColor(_ c: Fixture.Case<String, RGBAOutput?>) {
        let got = (try? CSSColor.parse(c.input)).map(RGBAOutput.init)
        #expect(got == c.output)
        #expect((RGBA(css: c.input) == nil) == (c.output == nil))
    }

    @Test func parseErrorNamesTheInput() {
        #expect(throws: CSSColorError(input: " red ")) { try CSSColor.parse(" red ") }
    }

    @Test(arguments: Fixture.cases("color", "isColorCases", input: String.self, output: Bool.self))
    func isColor(_ c: Fixture.Case<String, Bool>) {
        #expect(CSSColor.isColor(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("color", "toHexCases", input: [Double].self, output: String.self))
    func toHex(_ c: Fixture.Case<[Double], String>) {
        #expect(CSSColor.toHex(rgb(c.input)) == c.output)
    }

    @Test(arguments: Fixture.cases("color", "overCases", input: OverInput.self, output: [Double].self))
    func over(_ c: Fixture.Case<OverInput, [Double]>) throws {
        let got = try CSSColor.over(c.input.fg, c.input.backdrop)
        #expect(approxEqual(got.channels, c.output), "\(got.channels) vs \(c.output)")
    }

    @Test(arguments: Fixture.cases("color", "mixCases", input: MixInput.self, output: String.self))
    func mix(_ c: Fixture.Case<MixInput, String>) throws {
        #expect(try CSSColor.mix(c.input.a, c.input.b, c.input.amount) == c.output)
    }

    @Test(arguments: Fixture.cases("color", "alphaCases", input: AlphaInput.self, output: String.self))
    func alpha(_ c: Fixture.Case<AlphaInput, String>) throws {
        #expect(try CSSColor.alpha(c.input.c, c.input.a) == c.output)
    }

    @Test(arguments: Fixture.cases("color", "luminanceCases", input: [Double].self, output: Double.self))
    func luminance(_ c: Fixture.Case<[Double], Double>) {
        #expect(approxEqual(CSSColor.luminance(rgb(c.input)), c.output))
    }

    @Test(arguments: Fixture.cases("color", "contrastCases", input: ContrastInput.self, output: Double.self))
    func contrast(_ c: Fixture.Case<ContrastInput, Double>) throws {
        #expect(approxEqual(try CSSColor.contrast(c.input.fg, c.input.bg), c.output))
    }

    @Test(arguments: Fixture.cases("color", "oklabCases", input: String.self, output: [Double].self))
    func oklab(_ c: Fixture.Case<String, [Double]>) throws {
        #expect(approxEqual(try CSSColor.oklab(c.input), c.output))
    }

    @Test(arguments: Fixture.cases("color", "distanceCases", input: DistanceInput.self, output: Double.self))
    func distance(_ c: Fixture.Case<DistanceInput, Double>) throws {
        #expect(approxEqual(try CSSColor.distance(c.input.a, c.input.b), c.output))
    }

    @Test(arguments: Fixture.cases("color", "readableCases", input: ReadableInput.self, output: String.self))
    func readable(_ c: Fixture.Case<ReadableInput, String>) throws {
        let i = c.input
        #expect(try CSSColor.readable(i.color, backdrops: i.backdrops, min: i.min, toward: i.toward) == c.output)
    }

    @Test func colorFunctionsThrowOnBadInput() {
        #expect(throws: CSSColorError.self) { try CSSColor.over("red", "#fff") }
        #expect(throws: CSSColorError.self) { try CSSColor.mix("#fff", "var(--bg)", 0.5) }
        #expect(throws: CSSColorError.self) { try CSSColor.alpha("", 0.5) }
        #expect(throws: CSSColorError.self) { try CSSColor.contrast("#000", "transparent") }
        #expect(throws: CSSColorError.self) { try CSSColor.readable("#000", backdrops: ["nope"], min: 4.5, toward: "#fff") }
    }
}
