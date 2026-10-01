import Foundation
import Testing
@testable import HarnessKit

struct CodeKindInput: Decodable, Sendable {
    let fence: String
    let text: String
}

struct NormalizePatchInput: Decodable, Sendable {
    let text: String
    let name: String?
}

@Suite("code.ts parity")
struct CodeTests {
    @Test(arguments: Fixture.cases("code", "codeLanguageCases", input: String.self, output: String.self))
    func codeLanguage(_ c: Fixture.Case<String, String>) {
        #expect(sameScalars(Code.codeLanguage(c.input), c.output))
    }

    @Test(arguments: Fixture.cases("code", "looksLikeDiffCases", input: String.self, output: Bool.self))
    func looksLikeDiff(_ c: Fixture.Case<String, Bool>) {
        #expect(Code.looksLikeDiff(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("code", "codeKindCases", input: CodeKindInput.self, output: Code.Kind.self))
    func codeKind(_ c: Fixture.Case<CodeKindInput, Code.Kind>) {
        #expect(Code.codeKind(fence: c.input.fence, text: c.input.text) == c.output)
    }

    @Test(arguments: Fixture.cases("code", "normalizePatchCases", input: NormalizePatchInput.self, output: String.self))
    func normalizePatch(_ c: Fixture.Case<NormalizePatchInput, String>) {
        let got = c.input.name.map { Code.normalizePatch(c.input.text, name: $0) } ?? Code.normalizePatch(c.input.text)
        #expect(sameScalars(got, c.output), "\(got.debugDescription)")
    }
}
