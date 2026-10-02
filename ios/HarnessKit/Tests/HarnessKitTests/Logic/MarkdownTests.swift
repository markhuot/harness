import Foundation
import Testing
@testable import HarnessKit

/// Encodes with sorted keys, so two values compare by their exact JSON (code points included).
private func json(_ value: some Encodable) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys]
    return try e.encode(value)
}

@Suite("markdown.ts parity")
struct MarkdownTests {
    /// The output JSON is kept raw, so this checks both the parse and that the Codable shape
    /// (`t` discriminator, `null` alignments) is exactly the TS one.
    @Test(arguments: Fixture.cases("markdown", "parseBlocksCases", input: String.self, output: JSONValue.self))
    func parseBlocks(_ c: Fixture.Case<String, JSONValue>) throws {
        let got = Markdown.parseBlocks(c.input)
        #expect(try jsonEqual(json(got), json(c.output)))
        let decoded = try JSONDecoder().decode([Markdown.Block].self, from: json(c.output))
        #expect(try json(decoded) == json(got))
    }

    @Test(arguments: Fixture.cases("markdown", "inlineTokensCases", input: String.self, output: JSONValue.self))
    func inlineTokens(_ c: Fixture.Case<String, JSONValue>) throws {
        let got = Markdown.inlineTokens(c.input)
        #expect(try jsonEqual(json(got), json(c.output)))
        let decoded = try JSONDecoder().decode([Markdown.InlineToken].self, from: json(c.output))
        #expect(try json(decoded) == json(got))
    }

    @Test(arguments: Fixture.cases("markdown", "mediaInCases", input: String.self, output: JSONValue.self))
    func mediaIn(_ c: Fixture.Case<String, JSONValue>) throws {
        #expect(try jsonEqual(json(Markdown.mediaIn(Markdown.parseBlocks(c.input))), json(c.output)))
    }

    @Test(arguments: Fixture.cases("markdown", "plainTextCases", input: String.self, output: String.self))
    func plainText(_ c: Fixture.Case<String, String>) {
        let got = Markdown.plainText(c.input)
        #expect(got.unicodeScalars.elementsEqual(c.output.unicodeScalars), "\(got.debugDescription) vs \(c.output.debugDescription)")
    }

    @Test func unknownBlockKindThrows() {
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(Markdown.Block.self, from: Data(#"{"t":"video"}"#.utf8)) }
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(Markdown.InlineToken.self, from: Data(#"{"t":"image","text":"x"}"#.utf8)) }
    }
}
