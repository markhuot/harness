import Foundation
import Testing
@testable import HarnessKit

/// Equal as JSON with strings compared code unit by code unit (Swift's `==` on String would also
/// accept canonically equivalent text, which the TS doesn't).
private func same<T: Encodable>(_ a: T, _ b: T) throws -> Bool {
    try jsonEqual(JSONEncoder().encode(a), JSONEncoder().encode(b))
}

extension MentionsTests {
    struct CaretInput: Decodable, Sendable {
        let text: String
        let caret: Int
    }

    struct InsertInput: Decodable, Sendable {
        let text: String
        let mention: ActiveMention
        let path: String
    }

    struct RankInput: Decodable, Sendable {
        let paths: [String]
        let query: String
        let limit: Int?
        let demotePrefix: String?
    }
}

@Suite("mentions.ts parity")
struct MentionsTests {
    @Test(arguments: Fixture.cases("mentions", "activeMentionCases", input: CaretInput.self, output: ActiveMention?.self))
    func activeMention(_ c: Fixture.Case<CaretInput, ActiveMention?>) throws {
        let got = Mentions.activeMention(c.input.text, caret: c.input.caret)
        #expect(try same(got, c.output))
    }

    @Test(arguments: Fixture.cases("mentions", "insertMentionCases", input: InsertInput.self, output: TextInsertion.self))
    func insertMention(_ c: Fixture.Case<InsertInput, TextInsertion>) throws {
        let got = Mentions.insertMention(c.input.text, mention: c.input.mention, path: c.input.path)
        #expect(try same(got, c.output))
    }

    @Test(arguments: Fixture.cases("mentions", "formatMentionCases", input: String.self, output: String.self))
    func formatMention(_ c: Fixture.Case<String, String>) throws {
        #expect(try same(Mentions.formatMention(c.input), c.output))
    }

    @Test(arguments: Fixture.cases("mentions", "parseMentionsCases", input: String.self, output: [String].self))
    func parseMentions(_ c: Fixture.Case<String, [String]>) throws {
        #expect(try same(Mentions.parseMentions(c.input), c.output))
    }

    @Test(arguments: Fixture.cases("mentions", "rankPathsCases", input: RankInput.self, output: [String].self))
    func rankPaths(_ c: Fixture.Case<RankInput, [String]>) throws {
        let demote = c.input.demotePrefix.map { prefix in { (p: String) in p.utf16.starts(with: prefix.utf16) } }
        let got = Mentions.rankPaths(c.input.paths, query: c.input.query, limit: c.input.limit ?? 50, demote: demote)
        #expect(try same(got, c.output))
    }

    /// Picking the suggestion for every mention the fixtures find leaves the caret just after the
    /// inserted path (and its space), never inside a surrogate pair.
    @Test(arguments: Fixture.cases("mentions", "insertMentionCases", input: InsertInput.self, output: TextInsertion.self))
    func insertedCaretIsOnAScalarBoundary(_ c: Fixture.Case<InsertInput, TextInsertion>) {
        let got = Mentions.insertMention(c.input.text, mention: c.input.mention, path: c.input.path)
        let utf16 = got.text.utf16
        let index = utf16.index(utf16.startIndex, offsetBy: got.caret)
        #expect(index.samePosition(in: got.text.unicodeScalars) != nil)
    }
}
