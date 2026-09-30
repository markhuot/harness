import Testing
@testable import HarnessKit

struct KeyedInput: Decodable, Sendable, TicketKeyed {
    struct Ref: Decodable, Sendable { let key: String }
    let key: String
    let externalRef: Ref?
    var externalRefKey: String? { externalRef?.key }
}

struct KeyedOutput: Decodable, Sendable, Equatable {
    let displayKey: String
    let secondaryKey: String?
    let keyLabel: String
    let isLegacyMirror: Bool
}

@Suite("keys.ts parity")
struct KeysTests {
    @Test(arguments: Fixture.cases("keys", "projectKeyFromPathCases", input: String.self, output: String.self))
    func projectKeyFromPath(_ c: Fixture.Case<String, String>) {
        #expect(Keys.projectKeyFromPath(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("keys", "parseTicketKeyCases", input: String.self, output: Keys.TicketKey?.self))
    func parseTicketKey(_ c: Fixture.Case<String, Keys.TicketKey?>) {
        #expect(Keys.parseTicketKey(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("keys", "isTicketKeyCases", input: String.self, output: Bool.self))
    func isTicketKey(_ c: Fixture.Case<String, Bool>) {
        #expect(Keys.isTicketKey(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("keys", "checkProjectKeyCases", input: String.self, output: Keys.ProjectKeyCheck.self))
    func checkProjectKey(_ c: Fixture.Case<String, Keys.ProjectKeyCheck>) {
        let got = Keys.checkProjectKey(c.input)
        #expect(got == c.output)
        // Whatever checkProjectKey accepts, the pattern accepts too.
        if got.error == nil { #expect(Keys.matchesProjectKeyPattern(got.key)) }
    }

    @Test(arguments: Fixture.cases("keys", "projectKeyPatternCases", input: String.self, output: Bool.self))
    func projectKeyPattern(_ c: Fixture.Case<String, Bool>) {
        #expect(Keys.matchesProjectKeyPattern(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("keys", "keyedCases", input: KeyedInput.self, output: KeyedOutput.self))
    func remoteIDs(_ c: Fixture.Case<KeyedInput, KeyedOutput>) {
        let got = KeyedOutput(
            displayKey: Keys.displayKey(c.input),
            secondaryKey: Keys.secondaryKey(c.input),
            keyLabel: Keys.keyLabel(c.input),
            isLegacyMirror: Keys.isLegacyMirror(c.input)
        )
        // Compare scalars, not ==, so a canonically-equivalent-but-different string fails.
        #expect(Array(got.displayKey.unicodeScalars) == Array(c.output.displayKey.unicodeScalars))
        #expect(got.secondaryKey.map { Array($0.unicodeScalars) } == c.output.secondaryKey.map { Array($0.unicodeScalars) })
        #expect(Array(got.keyLabel.unicodeScalars) == Array(c.output.keyLabel.unicodeScalars))
        #expect(got.isLegacyMirror == c.output.isLegacyMirror)
    }
}
