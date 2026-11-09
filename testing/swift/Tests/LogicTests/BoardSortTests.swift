import Testing
import HarnessKit

// The Swift side of shared/src/state/boardSort.ts (testing/l0/state/boardSort.test.ts).
@Suite struct BoardSortTests {
    private func ticket(_ key: String, project: String = "p-A", title: String = "t", status: TicketStatus = .planning, position: Double = 0, createdAt: Double = 0, lastActiveAt: Double? = nil, updatedAt: Double = 0, completedAt: Double? = nil) -> Ticket {
        Ticket(
            id: "id-\(key)", key: key, projectId: project, title: title, spec: "", status: status, sessionId: "s-\(key)", driver: "claude-code",
            position: position, completedAt: completedAt.map { .value($0) } ?? .absent, lastActiveAt: lastActiveAt, createdAt: createdAt, updatedAt: updatedAt)
    }

    private func project(_ id: String, _ name: String) -> Project {
        Project(id: id, key: id.uppercased(), name: name, path: "/\(id)", nextSeq: 1, useWorktrees: true, createdAt: 0, updatedAt: 0)
    }

    private func state(_ ts: [Ticket], projects: [Project] = []) -> BoardState {
        var s = BoardState()
        for t in ts { s.tickets[t.id] = t }
        for p in projects { s.projects[p.id] = p }
        return s
    }

    private var sample: BoardState {
        state([
            ticket("A-1", title: "zebra", position: 1, createdAt: 1, lastActiveAt: 100),
            ticket("A-2", title: "Apple", position: 2, createdAt: 2, lastActiveAt: 900),
            ticket("A-3", title: "item 10", position: 3, createdAt: 3, lastActiveAt: 500),
            ticket("A-4", title: "Item 9", position: 4, createdAt: 4, lastActiveAt: 500),
        ])
    }

    @Test func recentPutsTheLatestActivityFirstAndBreaksTiesByCreationOrder() {
        #expect(sample.boardColumns(nil, sort: .recent).planning.map(\.key) == ["A-2", "A-3", "A-4", "A-1"])
    }

    @Test func createdKeepsPositionThenAgeAndIsTheSelectorsDefault() {
        #expect(sample.boardColumns(nil, sort: .created).planning.map(\.key) == ["A-1", "A-2", "A-3", "A-4"])
        #expect(sample.boardColumns(nil).planning.map(\.key) == ["A-1", "A-2", "A-3", "A-4"])
    }

    @Test func titleSortsAToZIgnoringCaseWithNumbersByValue() {
        #expect(sample.boardColumns(nil, sort: .title).planning.map(\.key) == ["A-2", "A-4", "A-3", "A-1"])
    }

    @Test func doneKeepsNewestCompletedFirstWhateverTheSort() {
        let s = state([
            ticket("D-1", title: "a", status: .done, lastActiveAt: 999, completedAt: 10),
            ticket("D-2", title: "b", status: .done, lastActiveAt: 1, completedAt: 20),
        ])
        for sort in BoardSort.allCases { #expect(s.boardColumns(nil, sort: sort).done.map(\.key) == ["D-2", "D-1"]) }
    }

    @Test func aTicketWithoutLastActiveAtFallsBackToUpdatedAtAndALiveTimeOnlyMovesItForward() {
        #expect(BoardOrder.lastActive(ticket("L-1", updatedAt: 700)) == 700)
        #expect(BoardOrder.lastActive(ticket("L-1", lastActiveAt: 5000), ["s-L-1": 3000]) == 5000)
        #expect(BoardOrder.lastActive(ticket("L-1", lastActiveAt: 5000), ["s-L-1": 8000]) == 8000)
    }

    @Test func aTranscriptEntryOrRunRecordsLiveActivityAndLeavesTheTicketAlone() {
        var s = state([ticket("A-1", lastActiveAt: 1000), ticket("A-2", lastActiveAt: 5000)])
        let before = s.tickets["id-A-1"]
        s.apply(.transcriptAppended(entry: TranscriptEntry(id: "e", sessionId: "s-A-1", seq: 1, role: .user, content: .text(text: "?"), createdAt: 9000)))
        #expect(s.tickets["id-A-1"] == before)
        #expect(s.boardColumns(nil, sort: .recent).planning.map(\.key) == ["A-1", "A-2"])
        // Under a second later: no change.
        s.apply(.transcriptAppended(entry: TranscriptEntry(id: "f", sessionId: "s-A-1", seq: 2, role: .user, content: .text(text: "?"), createdAt: 9500)))
        #expect(s.activeAt["s-A-1"] == 9000)
        s.apply(.runUpserted(run: Run(id: "r", sessionId: "s-A-2", kind: .work, status: .succeeded, driver: "claude-code", prompt: "", createdAt: 2000, startedAt: 3000, endedAt: 12000)))
        #expect(s.activeAt["s-A-2"] == 12000)
    }

    @Test func sectionsComeInProjectNameOrderKeepingTheColumnsOrderWithUnknownProjectsLast() {
        let projects = ["b": project("b", "Beta"), "a": project("a", "alpha")]
        let ts = [ticket("B-1", project: "b"), ticket("X-1", project: "gone"), ticket("A-2", project: "a"), ticket("B-2", project: "b"), ticket("A-1", project: "a")]
        let sections = BoardOrder.sectionsByProject(projects, ts)
        #expect(sections.map { $0.project?.name } == ["alpha", "Beta", nil])
        #expect(sections.map { $0.tickets.map(\.key) } == [["A-2", "A-1"], ["B-1", "B-2"], ["X-1"]])
    }

    @Test func groupingAppliesOnlyWhenTheBoardSpansProjects() {
        let s = state([], projects: [project("a", "alpha")])
        var prefs = Prefs.defaults
        #expect(!BoardColumns.groupsByProject(s, filter: nil, prefs: prefs))
        prefs.groupByProject = true
        #expect(BoardColumns.groupsByProject(s, filter: nil, prefs: prefs))
        #expect(BoardColumns.groupsByProject(s, filter: Paging.groupScope("g"), prefs: prefs))
        #expect(!BoardColumns.groupsByProject(s, filter: "a", prefs: prefs))
    }

    @Test func prefsDefaultToRecentUngroupedAndReadStoredChoices() {
        #expect(Prefs.defaults.sort == .recent)
        #expect(Prefs.defaults.groupByProject != true)
        let stored = Prefs.normalize(.object(["boardSort": .string("title"), "groupByProject": .bool(true), "version": .number(2)]))
        #expect(stored.sort == .title)
        #expect(stored.groupByProject == true)
        #expect(Prefs.normalize(.object(["boardSort": .string("bogus")])).sort == .recent)
    }

    @Test func thePaletteOffersTheOtherSortsAndGroupingOnlyOffAProjectsBoard() {
        let s = state([], projects: [project("a", "alpha")])
        let all = PaletteCommands.build(s, prefs: Prefs.defaults, focused: nil, canOpenFile: false).map(\.id)
        #expect(all.contains("board.sort.title") && all.contains("board.sort.created") && !all.contains("board.sort.recent"))
        #expect(all.contains("board.groupByProject"))
        var onProject = Prefs.defaults
        onProject.boardProject = "a"
        #expect(!PaletteCommands.build(s, prefs: onProject, focused: nil, canOpenFile: false).map(\.id).contains("board.groupByProject"))
    }
}
