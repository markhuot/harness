import Foundation
import Testing
@testable import HarnessKit

@Suite struct ChangesRowsTests {
    /// Two hunks of lib/greet.py: lines 2-6 (new) and 41-45, with gaps 1, 7-40 and (once the file is known) 46+.
    static let patch = [
        "diff --git a/lib/greet.py b/lib/greet.py",
        "index 1111111..2222222 100644",
        "--- a/lib/greet.py",
        "+++ b/lib/greet.py",
        "@@ -2,4 +2,5 @@ def greet(name):",
        "     x = 1",
        "-    return x",
        "+    y = 2",
        "+    return x + y",
        " ",
        " def other():",
        "@@ -40,5 +41,5 @@ class Greeter:",
        "     pass",
        "-    # old",
        "+    # new",
        "     done",
        "     x",
        "     y",
        "",
    ].joined(separator: "\n")

    static var diff: ChangesFileDiff { ChangesPatch.parse(patch)[0] }

    private func gaps(_ rows: [ChangesRow]) -> [ChangesGap] {
        rows.compactMap { if case let .gap(g) = $0 { g } else { nil } }
    }

    private func lines(_ rows: [ChangesRow]) -> [ChangesLine] {
        rows.compactMap { if case let .line(l) = $0 { l } else { nil } }
    }

    @Test func linesCarryBothSidesNumbers() {
        let l = lines(ChangesRows.rows(Self.diff))
        #expect(l.map(\.kind) == [.ctx, .del, .add, .add, .ctx, .ctx, .ctx, .del, .add, .ctx, .ctx, .ctx])
        #expect(l[0] == ChangesLine(kind: .ctx, text: "    x = 1", oldLine: 2, newLine: 2))
        #expect(l[1] == ChangesLine(kind: .del, text: "    return x", oldLine: 3, newLine: nil))
        #expect(l[3] == ChangesLine(kind: .add, text: "    return x + y", oldLine: nil, newLine: 4))
        #expect(l[4].text.isEmpty && l[4].oldLine == 4 && l[4].newLine == 5)
        #expect(l[8] == ChangesLine(kind: .add, text: "    # new", oldLine: nil, newLine: 42))
    }

    @Test func gapsBeforeEachHunkAndAnUnknownTrailingOne() {
        let g = gaps(ChangesRows.rows(Self.diff))
        #expect(g.map(\.index) == [0, 1, 2])
        #expect(g[0] == ChangesGap(index: 0, newStart: 1, oldStart: 1, count: 1, context: "def greet(name):"))
        // Hunk 1 ends at new line 6 / old line 5; hunk 2 starts at 41 / 40.
        #expect(g[1] == ChangesGap(index: 1, newStart: 7, oldStart: 6, count: 34, context: "class Greeter:"))
        #expect(g[2].count == nil && g[2].newStart == 46 && g[2].oldStart == 45)
    }

    @Test func expandingAGapNeedsTheContents() {
        let contents = (1...47).map { "line \($0)" }
        let noContents = ChangesRows.rows(Self.diff, expanded: [1])
        #expect(gaps(noContents).count == 3)

        let rows = ChangesRows.rows(Self.diff, contents: contents, expanded: [1])
        #expect(gaps(rows).map(\.index) == [0, 2])
        let filled = lines(rows).filter { $0.newLine.map { (7...40).contains($0) } ?? false }
        #expect(filled.count == 34)
        #expect(filled.first == ChangesLine(kind: .ctx, text: "line 7", oldLine: 6, newLine: 7))
        #expect(filled.last == ChangesLine(kind: .ctx, text: "line 40", oldLine: 39, newLine: 40))
        // With the contents known, the trailing gap has a count: lines 46 and 47.
        #expect(gaps(rows).last?.count == 2)
    }

    @Test func trailingGapExpandsToTheEndAndVanishesWhenNothingFollows() {
        let contents = (1...47).map { "l\($0)" }
        let rows = ChangesRows.rows(Self.diff, contents: contents, expanded: [2])
        #expect(lines(rows).suffix(2).map(\.newLine) == [46, 47])
        #expect(lines(rows).last?.oldLine == 46)
        let exact = ChangesRows.rows(Self.diff, contents: Array(contents.prefix(45)))
        #expect(gaps(exact).map(\.index) == [0, 1])
    }

    @Test func aHunkEndingShortOfGitsContextReachesTheEndOfTheFile() {
        let header = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n"
        let ends = ChangesPatch.parse(header + "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")[0]
        #expect(gaps(ChangesRows.rows(ends)).isEmpty)
        let more = ChangesPatch.parse(header + "@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n")[0]
        #expect(gaps(ChangesRows.rows(more)).map(\.index) == [1])
        // Once the contents are known they decide.
        #expect(gaps(ChangesRows.rows(ends, contents: ["a", "B", "c", "d"])).map(\.count) == [1])
    }

    @Test func newAndDeletedFilesHaveNoGaps() {
        let new = ChangesPatch.parse("diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n")[0]
        #expect(gaps(ChangesRows.rows(new)).isEmpty)
        let gone = ChangesPatch.parse("diff --git a/g.ts b/g.ts\ndeleted file mode 100644\n--- a/g.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n")[0]
        #expect(gaps(ChangesRows.rows(gone)).isEmpty)
        #expect(lines(ChangesRows.rows(gone)).map(\.oldLine) == [1, 2])
    }

    @Test func splitPairsEachChangeBlocksLines() {
        let split = ChangesRows.split(ChangesRows.rows(Self.diff))
        let rows: [ChangesSplitRow] = split.compactMap { if case let .row(r) = $0 { r } else { nil } }
        // ctx, (del|add), (nil|add), ctx, ctx, | ctx, (del|add), ctx, ctx, ctx
        #expect(rows.count == 10)
        #expect(rows[1].old?.text == "    return x" && rows[1].new?.text == "    y = 2")
        #expect(rows[2].old == nil && rows[2].new?.text == "    return x + y")
        // Each side points at its line's place in the unified order (its highlighted line).
        #expect([rows[1].oldCode, rows[1].newCode, rows[2].oldCode, rows[2].newCode] == [1, 2, nil, 3])
        #expect(rows[0].oldCode == 0 && rows[0].newCode == 0 && rows[7].newCode == 9)
        #expect(rows[0].old == rows[0].new)
        if case .gap = split[0] {} else { Issue.record("split keeps the leading gap") }
    }

    @Test func highlightSourceCountsEachRun() {
        let src = ChangesRows.highlightSource(ChangesRows.rows(Self.diff), path: "lib/greet.py")
        let parsed = Diff.parseDiff(src)
        // Every code row comes back as a code line of the same kind, in order.
        let kinds = parsed.lines.filter { $0.kind != .hunk && $0.kind != .meta }.map(\.kind.rawValue)
        #expect(kinds == lines(ChangesRows.rows(Self.diff)).map(\.kind.rawValue))
        #expect(parsed.files.map(\.path) == ["lib/greet.py"])
        #expect(src.contains("@@ -1,4 +1,5 @@") && src.contains("@@ -1,5 +1,5 @@"))
    }

    @Test func removedLinesThatLookLikeFileHeadersStayCodeLines() {
        let d = ChangesPatch.parse("diff --git a/h.md b/h.md\n--- a/h.md\n+++ b/h.md\n@@ -1,2 +1,2 @@\n--- a\n-x\n++++ b\n+y\n")[0]
        let src = ChangesRows.highlightSource(ChangesRows.rows(d), path: "h.md")
        let kinds = Diff.parseDiff(src).lines.filter { $0.kind != .hunk && $0.kind != .meta }.map(\.kind)
        #expect(kinds == [.del, .del, .add, .add])
    }

    @Test func contentsSplitLikeJS() {
        #expect(ChangesRows.lines(of: "a\nb\n") == ["a", "b"])
        #expect(ChangesRows.lines(of: "a\r\nb") == ["a", "b"])
        #expect(ChangesRows.lines(of: "a\n\n") == ["a", ""])
        #expect(ChangesRows.lines(of: "").isEmpty)
    }

    @Test func decorations() {
        #expect(ChangesRows.decoration(ChangedFile(path: "a.png", status: .added, additions: 0, deletions: 0, binary: true))?.text == "bin")
        #expect(ChangesRows.decoration(ChangedFile(path: "b", oldPath: "a", status: .renamed, additions: 0, deletions: 0))! == ("moved", "Renamed from a"))
        #expect(ChangesRows.decoration(ChangedFile(path: "b", status: .renamed, additions: 0, deletions: 0)) == nil)
        let edited = ChangesRows.decoration(ChangedFile(path: "b", oldPath: "a", status: .renamed, additions: 1, deletions: 2))!
        #expect(edited == ("+1 −2", "1 addition, 2 deletions"))
    }

    @Test func placeholders() throws {
        let file = ChangedFile(path: "x", status: .modified, additions: 1, deletions: 0)
        #expect(ChangesRows.placeholder(ChangedFile(path: "x", status: .added, additions: 0, deletions: 0, binary: true), diff: nil) == "Binary file not shown")
        #expect(ChangesRows.placeholder(file, diff: nil)?.contains("size limit") == true)
        #expect(ChangesRows.placeholder(file, diff: Self.diff) == nil)
        let mode = try #require(ChangesPatch.parse("diff --git a/r b/r\nold mode 100644\nnew mode 100755\n").first)
        #expect(ChangesRows.placeholder(file, diff: mode) == "Mode changed from 100644 to 100755")
        let empty = try #require(ChangesPatch.parse("diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n").first)
        #expect(ChangesRows.placeholder(file, diff: empty) == "Empty file")
    }

    @Test func emptyStatesAndNotices() throws {
        let samples = try Fixture.value("changes", "changesSamples", as: [Changes].self)
        var branch = samples[0]
        branch.files = []
        #expect(ChangesRows.emptyState(branch).detail.hasPrefix("harness/greet-1 matches main"))
        #expect(ChangesRows.emptyState(samples[1]).title == "No changes yet")
        #expect(ChangesRows.emptyState(samples[2]).title == "No changes")
        #expect(ChangesRows.notices(samples[2], error: nil) == ["This diff is large, so only the first part is shown. 1 file changed in total."])
        #expect(ChangesRows.notices(samples[0], error: "boom") == ["Refresh failed: boom"])
        // Without data the error is the whole screen, not a notice.
        #expect(ChangesRows.notices(nil, error: "boom").isEmpty)
    }

    @Test func relativeTimes() {
        let now = 10_000_000_000.0
        #expect(ChangesRows.relTime(now - 59_000, now: now) == "just now")
        #expect(ChangesRows.relTime(now - 90_000, now: now) == "2m ago")
        #expect(ChangesRows.relTime(now - 3_600_000 * 5, now: now) == "5h ago")
        #expect(ChangesRows.relTime(now - 3_600_000 * 49, now: now) == "2d ago")
    }
}

@Suite struct ChangesTabTests {
    static let git = PluginTab(pluginId: "git", id: "changes", title: "Changes", icon: "branch", when: .workdir)
    static let other = PluginTab(pluginId: "notes", id: "list", title: "Notes", when: .always)

    @Test func pluginLinkMapsToTheBuiltInTab() {
        #expect(ChangesTab.normalize("plugin:git:changes") == .changes)
        #expect(ChangesTab.normalize("plugin:notes:list") == "plugin:notes:list")
        #expect(ChangesTab.isTicketTab("changes"))
        #expect(ChangesTab.isTicketTab("plugin:git:changes"))
        #expect(!ChangesTab.isTicketTab("Changes"))
        #expect(!ChangesTab.isTicketTab(nil))
    }

    @Test func gitChangesNeverShowsAsAPluginTab() {
        #expect(ChangesTab.otherPluginTabs([Self.git, Self.other]) == [Self.other])
        #expect(ChangesTab.otherPluginTabs(nil) == nil)
    }

    @Test func showsWithAWorkdirOrAPinnedDiff() {
        #expect(ChangesTab.shows(workdir: "/w", pluginTabs: nil))
        #expect(ChangesTab.shows(workdir: nil, pluginTabs: [Self.git]))
        #expect(!ChangesTab.shows(workdir: nil, pluginTabs: [Self.other]))
        #expect(!ChangesTab.shows(workdir: nil, pluginTabs: nil))
    }

    @Test func effectiveTab() {
        #expect(ChangesTab.effectiveTab("plugin:git:changes", conductor: false, workdir: "/w", pluginTabs: [Self.git]) == .changes)
        // Plugin tabs not loaded yet: keep it, they may say the diff was pinned.
        #expect(ChangesTab.effectiveTab(.changes, conductor: false, workdir: nil, pluginTabs: nil) == .changes)
        #expect(ChangesTab.effectiveTab(.changes, conductor: false, workdir: nil, pluginTabs: [Self.other]) == .summaries)
        #expect(ChangesTab.effectiveTab(.changes, conductor: false, workdir: nil, pluginTabs: [Self.git]) == .changes)
        // Other tabs go through Tabs.effectiveTab, which no longer sees git:changes as a plugin tab.
        #expect(ChangesTab.effectiveTab("plugin:notes:list", conductor: false, workdir: nil, pluginTabs: [Self.git]) == .summaries)
        #expect(ChangesTab.effectiveTab("plugin:notes:list", conductor: false, workdir: nil, pluginTabs: [Self.other]) == "plugin:notes:list")
        #expect(ChangesTab.effectiveTab(.children, conductor: false, workdir: "/w", pluginTabs: nil) == .summaries)
    }

    @Test func visibleTabsPutChangesBeforeDetails() {
        #expect(ChangesTab.visibleTabs(conductor: false, workdir: "/w", subagents: nil, pluginTabs: [Self.git, Self.other])
            == [.summaries, .transcript, .browser, .changes, .details, "plugin:notes:list"])
        #expect(ChangesTab.visibleTabs(conductor: false, workdir: nil, subagents: nil, pluginTabs: [Self.other])
            == [.summaries, .transcript, .browser, .details, "plugin:notes:list"])
    }

    @Test func styleFallsBackOnNarrowScreensButKeepsTheChoice() {
        #expect(ChangesDiffStyle.effective(chosen: nil, width: 999) == .unified)
        #expect(ChangesDiffStyle.effective(chosen: nil, width: 1000) == .split)
        #expect(ChangesDiffStyle.effective(chosen: .split, width: 559) == .unified)
        #expect(ChangesDiffStyle.effective(chosen: .split, width: 560) == .split)
        #expect(ChangesDiffStyle.effective(chosen: .unified, width: 1200) == .unified)
        let store = MemoryChangesDefaults([ChangesDiffStyle.key: "sideways"])
        #expect(ChangesDiffStyle.read(store) == nil)
        ChangesDiffStyle.save(.split, to: store)
        #expect(ChangesDiffStyle.read(store) == .split)
    }

    @Test func pluginSourcePaths() {
        #expect(PluginChangesSource.changesPath(ticket: "GREET-1") == "/plugins/git/api/changes?ticket=GREET-1")
        #expect(PluginChangesSource.logPath(ticket: "A B", limit: 5) == "/plugins/git/api/log?ticket=A+B&limit=5")
        #expect(PluginChangesSource.filePath(ticket: "G-1", side: .old, path: "src/a b.ts", ref: "abc1234") == "/plugins/git/api/file?ticket=G-1&side=old&path=src%2Fa+b.ts&ref=abc1234")
        #expect(PluginChangesSource.filePath(ticket: "G-1", side: .new, path: "x", ref: "abc1234") == "/plugins/git/api/file?ticket=G-1&side=new&path=x")
    }

    @Test func pluginSourceDecodesTheEnvelope() async throws {
        let transport = FakeTransport { req in
            let body = req.url.path.hasSuffix("/file") ? #"{"data":{"contents":null}}"# : #"{"data":{"mode":"workdir","base":null,"commits":[]}}"#
            return HTTPResponse(status: 200, body: Data(body.utf8))
        }
        let source = PluginChangesSource(client: HarnessClient(baseUrl: "http://h", token: "t", transport: transport))
        let log = try await source.log(ticket: "G-1", limit: nil)
        #expect(log.mode == .workdir && log.commits.isEmpty)
        #expect(try await source.file(ticket: "G-1", side: .new, path: "gone.ts", ref: nil) == nil)
        #expect(transport.requests.map(\.url.absoluteString) == ["http://h/plugins/git/api/log?ticket=G-1", "http://h/plugins/git/api/file?ticket=G-1&side=new&path=gone.ts"])
    }
}
