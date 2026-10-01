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
        #expect(FileViewerRules.expandTabs("\ta\t") == "    a    ")
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

@Suite struct FileHighlightWindowsTests {
    /// 100 lines of 9 characters: 10 with their newline, so a 100-char budget fits 10 lines.
    static let lengths = Array(repeating: 9, count: 100)

    @Test func opensAroundTheCenter() {
        let w = FileHighlightWindows<String>(lengths: Self.lengths, center: 50, maxChars: 100)
        // It grows down first, so an even budget leans one line below the center.
        #expect(w.window == 46..<56)
    }

    @Test func scrollingInsideTheWindowDoesNotMoveIt() {
        var w = FileHighlightWindows<String>(lengths: Self.lengths, center: 50, maxChars: 100)
        let moved46_55 = w.visible(first: 46, last: 55)
        #expect(!moved46_55)
        #expect(w.window == 46..<56)
    }

    @Test func scrollingPastAnEdgeRecentersOnTheVisibleRows() {
        var w = FileHighlightWindows<String>(lengths: Self.lengths, center: 50, maxChars: 100)
        // `last` at the window's end (exclusive) is outside it.
        let moved50_56 = w.visible(first: 50, last: 56)
        #expect(moved50_56)
        // Math.round(53) = 53 → 10 lines around 53.
        #expect(w.window == 49..<59)
        // Math.round(42.5) = 43, not 42.
        let moved40_45 = w.visible(first: 40, last: 45)
        #expect(moved40_45)
        #expect(w.window == 39..<49)
    }

    @Test func coloredLinesPileUpUntilReset() {
        var w = FileHighlightWindows<String>(lengths: Self.lengths, center: 0, maxChars: 100)
        w.land(["a", "b"], from: 0)
        w.land(["c"], from: 90)
        #expect(w.colored == [0: "a", 1: "b", 90: "c"])
        // A later landing over the same line replaces it; lines past the end are dropped.
        w.land(["B", "x", "y"], from: 98)
        w.land(["b2"], from: 1)
        #expect(w.colored[1] == "b2" && w.colored[98] == "B" && w.colored[99] == "x" && w.colored[100] == nil)
        w.reset()
        #expect(w.colored.isEmpty)
    }

    @Test func anEmptyFileHasAnEmptyWindow() {
        var w = FileHighlightWindows<String>(lengths: [], center: 5)
        #expect(w.window.isEmpty)
        let moved0_0 = w.visible(first: 0, last: 0)
        #expect(!moved0_0)
        #expect(w.window.isEmpty)
    }
}
