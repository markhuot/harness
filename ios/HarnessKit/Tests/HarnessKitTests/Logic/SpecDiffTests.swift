import Foundation
import Testing
@testable import HarnessKit

/// Encodes with sorted keys, so two values compare by their exact JSON (code points included).
private func json(_ value: some Encodable) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys]
    return try e.encode(value)
}

@Suite("specDiff.ts parity")
struct SpecDiffTests {
    struct Pair: Decodable, Sendable {
        let before: String
        let after: String
    }

    /// The whole comparison, pinned by shared/fixtures/cases/specDiff.ts: alignment, pairing, the
    /// similarity guard and word runs, in the TS JSON shape.
    @Test(arguments: Fixture.cases("specDiff", "specDiffCases", input: Pair.self, output: JSONValue.self))
    func specDiff(_ c: Fixture.Case<Pair, JSONValue>) throws {
        let got = try json(MarkdownDiff.specDiff(c.input.before, c.input.after))
        #expect(try jsonEqual(got, json(c.output)), "\(String(decoding: got, as: UTF8.self))")
    }

    @Test func unchangedOnlyWhenEveryBlockIsTheSame() {
        #expect(MarkdownDiff.unchanged(MarkdownDiff.specDiff("# A\n\nb", "# A\n\nb")))
        #expect(MarkdownDiff.unchanged(MarkdownDiff.specDiff("", "")))
        #expect(!MarkdownDiff.unchanged(MarkdownDiff.specDiff("# A\n\nb", "# A\n\nc")))
        #expect(!MarkdownDiff.unchanged(MarkdownDiff.specDiff("# A", "# A\n\n---")))
    }

    /// JS compares code units, so a precomposed é and e + U+0301 differ even though Swift's
    /// String == calls them equal.
    @Test func canonicallyEquivalentTextStillDiffers() {
        let got = MarkdownDiff.specDiff("caf\u{E9} ok", "cafe\u{301} ok")
        #expect(!MarkdownDiff.unchanged(got))
    }

    @Test func mediaListsTheNewerRevisionsAttachmentsFirstOnce() {
        let ids = MarkdownDiff.media("![a](attachment:a)\n\n![b](attachment:b)", "![c](attachment:c)\n\n![a](attachment:a)").map(\.id)
        #expect(ids == ["c", "a", "b"])
    }
}
