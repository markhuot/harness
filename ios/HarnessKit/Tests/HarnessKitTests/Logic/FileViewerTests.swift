import Foundation
import Testing
@testable import HarnessKit

struct FileRouteForInput: Decodable, Sendable {
    let link: FileLink
    let ctx: FileLinkContext?
}

struct TriageLinkContextInput: Decodable, Sendable {
    struct Dispatched: Decodable, Sendable { let projectId: String }
    let key: String?
    let dispatched: Dispatched?
}

/// expo-router's params: each value a string or an array of strings.
struct RouterParamsInput: Decodable, Sendable {
    let params: [String: [String]]

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        var params: [String: [String]] = [:]
        for key in c.allKeys {
            if let one = try? c.decode(String.self, forKey: key) {
                params[key.stringValue] = [one]
            } else {
                params[key.stringValue] = try c.decode([String].self, forKey: key)
            }
        }
        self.params = params
    }
}

struct InitialScrollInput: Decodable, Sendable {
    let start: Int?
    let total: Int
    let context: Int?
}

struct HighlightWindowInput: Decodable, Sendable {
    let lengths: [Int]
    let center: Int
    let maxChars: Int
}

@Suite("fileViewer.ts parity")
struct FileViewerTests {
    @Test(arguments: Fixture.cases("fileViewer", "fileRouteForCases", input: FileRouteForInput.self, output: FileRouteParams?.self))
    func fileRouteFor(_ c: Fixture.Case<FileRouteForInput, FileRouteParams?>) {
        let got = c.input.ctx.map { FileViewer.fileRouteFor(c.input.link, context: $0) } ?? FileViewer.fileRouteFor(c.input.link)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("fileViewer", "fileRouteForURLCases", input: String.self, output: FileRouteParams?.self))
    func fileRouteForURL(_ c: Fixture.Case<String, FileRouteParams?>) {
        let got = FileViewer.fileRoute(forURL: c.input)
        #expect(got == c.output)
        #expect(sameScalars(got?.path, c.output?.path))
    }

    @Test(arguments: Fixture.cases("fileViewer", "triageLinkContextCases", input: TriageLinkContextInput.self, output: FileLinkContext.self))
    func triageLinkContext(_ c: Fixture.Case<TriageLinkContextInput, FileLinkContext>) {
        #expect(FileViewer.triageLinkContext(dispatchedKey: c.input.key, dispatchedProjectId: c.input.dispatched?.projectId) == c.output)
    }

    @Test(arguments: Fixture.cases("fileViewer", "readFileParamsCases", input: RouterParamsInput.self, output: FileTarget?.self))
    func readFileParams(_ c: Fixture.Case<RouterParamsInput, FileTarget?>) throws {
        let got = FileViewer.readFileParams(c.input.params)
        #expect(got == c.output)
        #expect(sameScalars(got?.path, c.output?.path))
    }

    @Test("readFileParams(FileRouteParams) reads a route this app built, round trip from a URL")
    func readRouteParams() {
        let route = FileViewer.fileRoute(forURL: "harness://file/src/app.ts?ticket=K-1#L5-L2")!
        #expect(FileViewer.readFileParams(route) == FileTarget(root: .ticket(key: "K-1"), path: "src/app.ts", range: 2...5))
        #expect(FileViewer.readFileParams(FileRouteParams(path: "a", ticket: "", project: "p", start: "3", end: "x")) == FileTarget(root: .project(id: "p"), path: "a", range: 3...3))
        #expect(FileViewer.readFileParams(FileRouteParams(path: "")) == nil)
    }

    @Test("FileTarget encodes like the TS: root object, range as [start, end], nulls written")
    func fileTargetEncoding() throws {
        let a = try JSONEncoder().encode(FileTarget(root: .project(id: "p"), path: "a", range: 2...5))
        #expect(try jsonEqual(a, Data(#"{"root":{"kind":"project","id":"p"},"path":"a","range":[2,5]}"#.utf8)))
        let b = try JSONEncoder().encode(FileTarget(root: nil, path: "a", range: nil))
        #expect(try jsonEqual(b, Data(#"{"root":null,"path":"a","range":null}"#.utf8)))
    }

    @Test(arguments: Fixture.cases("fileViewer", "fileLinesCases", input: String.self, output: [String].self))
    func fileLines(_ c: Fixture.Case<String, [String]>) {
        let got = FileViewer.fileLines(c.input)
        #expect(got.count == c.output.count && zip(got, c.output).allSatisfy { sameScalars($0, $1) }, "\(got)")
    }

    @Test(arguments: Fixture.cases("fileViewer", "initialScrollIndexCases", input: InitialScrollInput.self, output: Int.self))
    func initialScrollIndex(_ c: Fixture.Case<InitialScrollInput, Int>) {
        let got = c.input.context.map { FileViewer.initialScrollIndex(start: c.input.start, total: c.input.total, context: $0) }
            ?? FileViewer.initialScrollIndex(start: c.input.start, total: c.input.total)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("fileViewer", "highlightWindowCases", input: HighlightWindowInput.self, output: [Int].self))
    func highlightWindow(_ c: Fixture.Case<HighlightWindowInput, [Int]>) {
        let got = FileViewer.highlightWindow(lengths: c.input.lengths, center: c.input.center, maxChars: c.input.maxChars)
        #expect([got.lowerBound, got.upperBound] == c.output)
    }

    @Test(arguments: Fixture.cases("fileViewer", "patchRowsCases", input: String.self, output: [PatchRow].self))
    func patchRows(_ c: Fixture.Case<String, [PatchRow]>) {
        let got = FileViewer.patchRows(c.input)
        #expect(got == c.output)
        #expect(got.count == c.output.count && zip(got, c.output).allSatisfy { sameScalars($0.text, $1.text) })
    }

    @Test(arguments: Fixture.cases("fileViewer", "formatSizeCases", input: Double.self, output: String.self))
    func formatSize(_ c: Fixture.Case<Double, String>) {
        #expect(FileViewer.formatSize(c.input) == c.output)
    }

    @Test("formatSize for sizes JSON can't carry")
    func formatSizeNonFinite() {
        // Number formatting as in JS: `${NaN}` and `${Infinity}`.
        #expect(FileViewer.formatSize(.nan) == "NaN KB")
        #expect(FileViewer.formatSize(.infinity) == "Infinity GB")
        #expect(FileViewer.formatSize(-.infinity) == "-Infinity B")
    }
}
