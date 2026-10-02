import Foundation
import Testing
@testable import HarnessKit

/// An expo-router param: a string, an array of strings, or null/missing. The iOS app reads the
/// first value itself (URLComponents query items), so the test does what the TS `one()` does.
struct RouteValue: Decodable, Sendable {
    let first: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { first = nil }
        else if let s = try? c.decode(String.self) { first = s }
        else { first = try c.decode([String].self).first }
    }
}

struct PairParamsInput: Decodable, Sendable {
    let url: RouteValue?
    let token: RouteValue?
}

@Suite("mobile pair.ts parity")
struct MobilePairTests {
    @Test(arguments: Fixture.cases("mobilePair", "normalizeBaseUrlCases", input: String.self, output: ParseResult<String>.self))
    func normalizeBaseUrl(_ c: Fixture.Case<String, ParseResult<String>>) {
        let got = MobilePair.normalizeBaseUrl(c.input)
        #expect(got == c.output)
        #expect(sameScalars(got.value, c.output.value))
    }

    @Test(arguments: Fixture.cases("mobilePair", "checkTokenCases", input: String.self, output: ParseResult<String>.self))
    func checkToken(_ c: Fixture.Case<String, ParseResult<String>>) {
        #expect(MobilePair.checkToken(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("mobilePair", "parsePairLinkCases", input: String.self, output: ParseResult<ServerAddress>.self))
    func parsePairLink(_ c: Fixture.Case<String, ParseResult<ServerAddress>>) {
        #expect(MobilePair.parsePairLink(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("mobilePair", "pairParamsCases", input: PairParamsInput.self, output: ParseResult<ServerAddress>.self))
    func pairParams(_ c: Fixture.Case<PairParamsInput, ParseResult<ServerAddress>>) {
        #expect(MobilePair.pairParams(url: c.input.url?.first, token: c.input.token?.first) == c.output)
    }

    @Test(arguments: Fixture.cases("mobilePair", "displayHostCases", input: String.self, output: String.self))
    func displayHost(_ c: Fixture.Case<String, String>) {
        #expect(MobilePair.displayHost(c.input) == c.output)
    }

    @Test func parseResultRoundTripsThroughJSON() throws {
        let ok = ParseResult<String>.ok("x")
        let bad = ParseResult<String>.failure("nope")
        for r in [ok, bad] {
            let back = try JSONDecoder().decode(ParseResult<String>.self, from: JSONEncoder().encode(r))
            #expect(back == r)
        }
        #expect(ok != .failure("x"))
    }
}
