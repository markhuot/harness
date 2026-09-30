import Testing
@testable import HarnessKit

struct BuildPairUrlInput: Decodable, Sendable {
    let baseUrl: String
    let token: String
}

@Suite("pairing.ts parity")
struct PairingTests {
    @Test(arguments: Fixture.cases("pairing", "buildPairUrlCases", input: BuildPairUrlInput.self, output: String.self))
    func buildPairUrl(_ c: Fixture.Case<BuildPairUrlInput, String>) {
        #expect(Pairing.buildPairUrl(baseUrl: c.input.baseUrl, token: c.input.token) == c.output)
    }

    @Test(arguments: Fixture.cases("pairing", "parsePairUrlCases", input: String.self, output: Pairing.Link?.self))
    func parsePairUrl(_ c: Fixture.Case<String, Pairing.Link?>) {
        #expect(Pairing.parsePairUrl(c.input) == c.output)
    }
}
