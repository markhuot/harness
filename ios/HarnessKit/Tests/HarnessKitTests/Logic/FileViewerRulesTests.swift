import Foundation
import Testing
@testable import HarnessKit

@Suite struct FileViewerRulesTests {
    static func git(repo: Bool = true, dirty: Bool = false, untracked: Bool = false, ignored: Bool = false) -> FileGitState {
        FileGitState(repo: repo, tracked: !untracked && !ignored, dirty: dirty, untracked: untracked, ignored: ignored)
    }

    static func view(size: Int = 10, contents: String? = "x", binary: Bool = false, truncated: Bool = false, tooLarge: Bool = false) -> FileView {
        FileView(path: "a", root: "/", size: size, contents: contents, binary: binary, truncated: truncated, tooLarge: tooLarge, git: git())
    }

    @Test func fileNameIsTheLastNonEmptySegment() {
        #expect(FileViewerRules.fileName("src/lib/a.ts") == "a.ts")
        #expect(FileViewerRules.fileName("src/lib/") == "lib")
        #expect(FileViewerRules.fileName("a.ts") == "a.ts")
        // Nothing but slashes: no segment, so the path itself.
        #expect(FileViewerRules.fileName("//") == "//")
    }

    @Test func subtitleIsTheKeyOrTheProjectName() {
        #expect(FileViewerRules.subtitle(.ticket(key: "GREET-1"), projectName: "Greetings") == "GREET-1")
        #expect(FileViewerRules.subtitle(.project(id: "p"), projectName: "Greetings") == "Greetings")
        #expect(FileViewerRules.subtitle(.project(id: "p"), projectName: nil) == "Project")
    }

    @Test func drawnLengthCountsTabsAsFourAndUTF16Units() {
        #expect(FileViewerRules.drawnLength("\tab") == 6)
        #expect(FileViewerRules.drawnLength("😀") == 2)
        #expect(FileViewerRules.drawnLength("") == 0)
    }

    @Test func untrackedWinsOverModified() {
        #expect(FileViewerRules.gitBadge(Self.git(dirty: true, untracked: true)) == .untracked)
        #expect(FileViewerRules.gitBadge(Self.git(dirty: true)) == .modified)
        #expect(FileViewerRules.gitBadge(Self.git(ignored: true)) == nil)
    }

    @Test func onlyADirtyFileInARepoHasADiff() {
        var v = Self.view()
        v.git = Self.git(dirty: true)
        #expect(FileViewerRules.hasDiff(v))
        v.git = Self.git(repo: false, dirty: true)
        #expect(!FileViewerRules.hasDiff(v))
        v.git = Self.git()
        #expect(!FileViewerRules.hasDiff(v))
    }

    @Test func metaJoinsWhatIsKnown() {
        #expect(FileViewerRules.meta(size: 2048, lineCount: 1, range: 5...5) == "2.0 KB · 1 line · line 5")
        #expect(FileViewerRules.meta(size: 10, lineCount: 40, range: 3...9) == "10 B · 40 lines · lines 3–9")
        #expect(FileViewerRules.meta(size: 10, lineCount: nil, range: nil) == "10 B")
        #expect(FileViewerRules.meta(size: nil, lineCount: nil, range: nil) == "")
    }

    @Test func diffCountsAndLabel() {
        let rows = FileViewer.patchRows("@@ -1,3 +1,2 @@\n a\n-b\n-c\n+d\n")
        let n = FileViewerRules.diffCounts(rows)
        #expect(n.added == 1 && n.removed == 2)
        #expect(FileViewerRules.diffCountLabel(added: 1, removed: 2) == "+1 −2")
        #expect(FileViewerRules.diffCountLabel(added: 3, removed: 0) == "+3")
        #expect(FileViewerRules.diffCountLabel(added: 0, removed: 1) == "−1")
        #expect(FileViewerRules.diffCountLabel(added: 0, removed: 0) == nil)
    }

    @Test func fileBodyStatesInOrder() {
        // Too large wins even though contents is null like a binary file's.
        #expect(FileViewerRules.fileBody(Self.view(size: 3 * 1024 * 1024, contents: nil, tooLarge: true)) == .tooLarge("This file is 3.0 MB; the viewer opens files up to 2 MB."))
        #expect(FileViewerRules.fileBody(Self.view(size: 2048, contents: nil, binary: true)) == .binary("2.0 KB of binary data."))
        #expect(FileViewerRules.fileBody(Self.view(contents: nil)) == .binary("10 B of binary data."))
        #expect(FileViewerRules.fileBody(Self.view(contents: "")) == .empty)
        #expect(FileViewerRules.fileBody(Self.view(truncated: true)) == .lines(truncated: true))
        #expect(FileViewerRules.fileBody(Self.view()) == .lines(truncated: false))
    }

    @Test func diffBodyStatesInOrder() {
        let rows = FileViewer.patchRows("@@ -1 +1 @@\n-a\n+b\n")
        #expect(FileViewerRules.diffBody(nil, rows: []) == .loading)
        #expect(FileViewerRules.diffBody(.loading, rows: []) == .loading)
        let e = FileLoadError(status: 409, message: "not a repo")
        #expect(FileViewerRules.diffBody(.error(e), rows: []) == .error(e))
        #expect(FileViewerRules.diffBody(.ok(FileDiff(path: "a", patch: "", tooLarge: true)), rows: []) == .tooLarge)
        #expect(FileViewerRules.diffBody(.ok(FileDiff(path: "a", patch: "")), rows: []) == .noChanges)
        #expect(FileViewerRules.diffBody(.ok(FileDiff(path: "a", patch: "Binary files a and b differ\n")), rows: []) == .binary)
        #expect(FileViewerRules.diffBody(.ok(FileDiff(path: "a", patch: "x")), rows: rows) == .rows)
    }

    @Test func errorCopyByStatus() {
        let notFound = FileViewerRules.errorCopy(.file, FileLoadError(status: 404, message: "nope"), path: "src/a.ts")
        #expect(notFound.title == "File not found" && !notFound.retry && notFound.message.hasPrefix("src/a.ts isn't there"))
        let bad = FileViewerRules.errorCopy(.file, FileLoadError(status: 400, message: "Path escapes the root"), path: "../x")
        #expect(bad.title == "Can't open this path" && bad.message == "Path escapes the root" && !bad.retry)
        let other = FileViewerRules.errorCopy(.file, FileLoadError(status: 500, message: "boom"), path: "a")
        #expect(other.title == "Couldn't load the file" && other.retry)
        // A 404 on the diff isn't "File not found": the file itself loaded.
        let diff404 = FileViewerRules.errorCopy(.diff, FileLoadError(status: 404, message: "gone"), path: "a")
        #expect(diff404.title == "Couldn't load the diff" && diff404.retry)
    }

    @Test func linkCarriesRootAndRange() {
        #expect(FileViewerRules.link(path: "src/a b.ts", root: .ticket(key: "GREET-1"), range: 3...3) == "harness://file/src/a%20b.ts?ticket=GREET-1#L3")
        #expect(FileViewerRules.link(path: "a.ts", root: .project(id: "p1"), range: 3...9) == "harness://file/a.ts?project=p1#L3-L9")
        #expect(FileViewerRules.link(path: "a.ts", root: .project(id: "p1"), range: nil) == "harness://file/a.ts?project=p1")
    }

    @Test func fileTextMeasuresExpandedLines() {
        let t = FileText("a\n\tbb\r\nc\n")
        #expect(t.lines == ["a", "\tbb", "c"])
        #expect(t.lengths == [1, 6, 1])
        #expect(t.longest == 6)
        #expect(FileText("").longest == 0)
    }
}
