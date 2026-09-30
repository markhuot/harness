import Testing
@testable import HarnessKit

/// Code-point equality (Swift's String == also equates canonically equivalent strings).
func sameScalars(_ a: String?, _ b: String?) -> Bool {
    switch (a, b) {
    case (nil, nil): true
    case let (a?, b?): a.unicodeScalars.elementsEqual(b.unicodeScalars)
    default: false
    }
}

struct LineRangeLabelInput: Decodable, Sendable {
    let path: String
    let startLine: Int?
    let endLine: Int?
}

@Suite("fileLinks.ts parity")
struct FileLinksTests {
    @Test(arguments: Fixture.cases("fileLinks", "parseFileLinkCases", input: String.self, output: FileLink?.self))
    func parseFileLink(_ c: Fixture.Case<String, FileLink?>) {
        let got = FileLinks.parseFileLink(c.input)
        #expect(got == c.output)
        #expect(sameScalars(got?.path, c.output?.path))
    }

    @Test(arguments: Fixture.cases("fileLinks", "formatFileLinkCases", input: FileLink.self, output: String.self))
    func formatFileLink(_ c: Fixture.Case<FileLink, String>) {
        #expect(FileLinks.formatFileLink(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("fileLinks", "roundTripCases", input: FileLink.self, output: FileLink?.self))
    func roundTrip(_ c: Fixture.Case<FileLink, FileLink?>) {
        let got = FileLinks.parseFileLink(FileLinks.formatFileLink(c.input))
        #expect(got == c.output)
        #expect(got == c.input)
    }

    @Test(arguments: Fixture.cases("fileLinks", "lineRangeLabelCases", input: LineRangeLabelInput.self, output: String.self))
    func lineRangeLabel(_ c: Fixture.Case<LineRangeLabelInput, String>) {
        #expect(FileLinks.lineRangeLabel(path: c.input.path, startLine: c.input.startLine, endLine: c.input.endLine) == c.output)
    }
}
