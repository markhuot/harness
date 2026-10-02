import Foundation
import Testing
@testable import HarnessKit

@Suite("diff.ts parity")
struct DiffTests {
    @Test(arguments: Fixture.cases("diff", "langForPathCases", input: String.self, output: String?.self))
    func langForPath(_ c: Fixture.Case<String, String?>) {
        #expect(sameScalars(Diff.langForPath(c.input), c.output))
    }

    @Test(arguments: Fixture.cases("diff", "parseDiffCases", input: String.self, output: ParsedDiff.self))
    func parseDiff(_ c: Fixture.Case<String, ParsedDiff>) {
        let got = Diff.parseDiff(c.input)
        #expect(got == c.output)
        #expect(got.lines.count == c.output.lines.count && zip(got.lines, c.output.lines).allSatisfy { sameScalars($0.text, $1.text) })
        #expect(got.files.count == c.output.files.count && zip(got.files, c.output.files).allSatisfy { sameScalars($0.path, $1.path) })
    }

    @Test("DiffFile writes path: null, as the TS does")
    func nullPathEncodes() throws {
        let data = try JSONEncoder().encode(DiffFile(path: nil))
        #expect(String(decoding: data, as: UTF8.self) == #"{"path":null}"#)
    }
}
