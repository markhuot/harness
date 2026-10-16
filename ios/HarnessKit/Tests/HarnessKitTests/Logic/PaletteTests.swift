import Foundation
import Testing
@testable import HarnessKit

@Suite("Command palette: ranking, prefixes, file queries, rows")
struct PaletteTests {
    struct Item: PaletteRankable {
        var label: String
        var keywords: [String] = []
        var recentRank: Int?
    }

    static func labels(_ q: String, _ items: [Item]) -> [String] { PaletteRanker.rank(q, items).map { items[$0.index].label } }

    static func ticket(_ id: String, _ title: String, status: TicketStatus = .planning, project: String = "p1") -> Ticket {
        Ticket(id: id, key: "K-\(id)", projectId: project, title: title, spec: "", status: status, sessionId: "s\(id)", driver: "dummy",
               position: 0, createdAt: 1, updatedAt: 1)
    }

    static func state(_ tickets: [Ticket], search: [String]? = nil) -> BoardState {
        var s = BoardState()
        s.projects["p1"] = Project(id: "p1", key: "P", name: "Proj", path: "/p", nextSeq: 1, useWorktrees: false, createdAt: 1, updatedAt: 1)
        for t in tickets { s.tickets[t.id] = t }
        return s
    }

    // MARK: Terminals

    static func terminal(_ id: String, cwd: String = "/Users/me/Sites", title: String = "", process: String = "zsh", createdAt: Double = 0) -> TerminalInfo {
        TerminalInfo(id: id, cwd: cwd, title: title, process: process, createdAt: createdAt)
    }

    @Test func terminalsAreRowsOfTheirOwnAndNewTerminalIsACommand() {
        let s = Self.state([])
        let commands = PaletteCommands.build(s, prefs: .defaults, focused: nil, canOpenFile: false)
        #expect(commands.contains { $0.id == "new-terminal" && $0.action == .newTerminal })
        let terms = [Self.terminal("old", createdAt: 1), Self.terminal("new", title: "npm run dev", process: "node", createdAt: 2)]
        let rows = PaletteRows.rows(PaletteQuery.parse(""), commands: commands, state: s, searchIDs: nil, terminals: terms)
        let ids = rows.map(\.id)
        #expect(ids.filter { $0.hasPrefix("terminal:") } == ["terminal:new", "terminal:old"])
        #expect(ids.firstIndex(of: "terminal:new")! > ids.firstIndex(of: "cmd:new-terminal")!)
    }

    @Test func aTerminalMatchesOnItsTitleProgramAndFolder() {
        let s = Self.state([])
        let terms = [Self.terminal("a", cwd: "/Users/me/Sites/harness", title: "vim DESIGN.md", process: "vim"), Self.terminal("b", cwd: "/tmp", process: "sleep")]
        func found(_ q: String) -> [String] {
            PaletteRows.rows(PaletteQuery.parse(q), commands: [], state: s, searchIDs: nil, terminals: terms).compactMap { if case let .terminal(t) = $0.content { t.id } else { nil } }
        }
        #expect(found("design") == ["a"])
        #expect(found("sleep") == ["b"])
        #expect(found("harness") == ["a"])
        #expect(found("terminal").sorted() == ["a", "b"]) // the word "terminal" lists them all
        #expect(found("zzz").isEmpty)
    }

    @Test func aTicketOnlyQueryNeverListsTerminals() {
        let s = Self.state([Self.ticket("1", "vim keybindings")])
        let rows = PaletteRows.rows(PaletteQuery.parse("# vim"), commands: [], state: s, searchIDs: nil, terminals: [Self.terminal("a", process: "vim")])
        #expect(rows.map(\.id) == ["ticket:K-1"])
    }

    // MARK: Ranking

    @Test func tiersPrefixThenWordThenRunThenScattered() {
        let items = ["Reopen Settings", "New Session", "Session list", "Assess"].map { Item(label: $0) }
        #expect(Self.labels("sess", items) == ["Session list", "New Session", "Assess"])
        // "ns" picks out word initials (tier word) ahead of the scattered letters in "Session list".
        #expect(Self.labels("ns", items).first == "New Session")
        #expect(Self.labels("zz", items).isEmpty)
        #expect(Self.labels("rse", items) == ["Reopen Settings"])
    }

    @Test func emptyQueryPutsRecentsFirstThenKeepsOrder() {
        let items = [Item(label: "A"), Item(label: "B", recentRank: 1), Item(label: "C", recentRank: 0)]
        #expect(Self.labels("  ", items) == ["C", "B", "A"])
    }

    @Test func aKeywordMatchRanksBelowALabelMatch() {
        let items = [Item(label: "Board: Web", keywords: ["api"]), Item(label: "API docs")]
        #expect(Self.labels("api", items) == ["API docs", "Board: Web"])
    }

    @Test func highlightsAreCharacterOffsetsEvenAfterAccentsAndEmoji() {
        // "é" and the emoji are one Character each, though more than one UTF-16 unit.
        let m = PaletteRanker.match("sess", "Café 🚀 Session")
        #expect(m?.ranges == [7..<11])
        let initials = PaletteRanker.match("cs", "Café Session")
        #expect(initials?.ranges == [0..<1, 5..<6])
    }

    @Test func casefoldingAcrossNonASCII() {
        #expect(PaletteRanker.match("éco", "Écoute")?.tier == 4)
    }

    // MARK: Prefixes

    @Test func prefixesPickTheMode() {
        #expect(PaletteQuery.parse(">  approve ") == PaletteQuery(mode: .commands, text: "approve"))
        #expect(PaletteQuery.parse("#K-3") == PaletteQuery(mode: .tickets, text: "K-3"))
        #expect(PaletteQuery.parse("  @src/a.ts") == PaletteQuery(mode: .files, text: "src/a.ts"))
        #expect(PaletteQuery.parse("fix #12") == PaletteQuery(mode: .all, text: "fix #12"))
    }

    @Test func greaterThanNeverAsksForTicketsOrFiles() {
        let q = PaletteQuery.parse("> src/app.ts login")
        #expect(q.wantsCommands && !q.wantsTickets && !q.wantsFiles)
        #expect(PaletteQuery.parse("#x").wantsTickets && !PaletteQuery.parse("#x").wantsCommands)
        #expect(PaletteQuery.parse("@x").wantsFiles)
    }

    // MARK: File queries

    @Test func fileQuerySplitsLinesAndRanges() {
        #expect(PaletteFileQuery.parse("src/a.ts") == PaletteFileQuery(search: "src/a.ts"))
        #expect(PaletteFileQuery.parse("src/a.ts:12") == PaletteFileQuery(search: "src/a.ts", startLine: 12))
        #expect(PaletteFileQuery.parse("src/a.ts:12-20") == PaletteFileQuery(search: "src/a.ts", startLine: 12, endLine: 20))
        #expect(PaletteFileQuery.parse("src/a.ts:12:3") == PaletteFileQuery(search: "src/a.ts", startLine: 12))
        #expect(PaletteFileQuery.parse("src/a.ts#L12") == PaletteFileQuery(search: "src/a.ts", startLine: 12))
        #expect(PaletteFileQuery.parse("src/a.ts#L12-L20") == PaletteFileQuery(search: "src/a.ts", startLine: 12, endLine: 20))
        #expect(PaletteFileQuery.parse("src/a.ts#L12-20") == PaletteFileQuery(search: "src/a.ts", startLine: 12, endLine: 20))
        #expect(PaletteFileQuery.parse("a.ts:20-12") == PaletteFileQuery(search: "a.ts", startLine: 12, endLine: 20))
        #expect(PaletteFileQuery.parse("a.ts:5-5") == PaletteFileQuery(search: "a.ts", startLine: 5))
        #expect(PaletteFileQuery.parse("a.ts:0") == PaletteFileQuery(search: "a.ts"))
    }

    @Test func fileRootIsTheFocusedTicketElseTheProject() {
        #expect(PaletteFileRoot.pick(focusedTicket: "K-1", project: "p1") == .ticket("K-1"))
        #expect(PaletteFileRoot.pick(focusedTicket: nil, project: "p1") == .project("p1"))
        #expect(PaletteFileRoot.pick(focusedTicket: nil, project: nil) == nil)
    }

    @Test func recentsAreKeyedByRootCappedAndDeduped() {
        let defaults = UserDefaults(suiteName: "palette-tests-\(UUID().uuidString)")!
        let t = PaletteFileRoot.ticket("K-1"), p = PaletteFileRoot.project("p1")
        PaletteRecents.push(t.fileID("a.ts"), defaults)
        PaletteRecents.push(p.fileID("a.ts"), defaults)
        PaletteRecents.push(t.fileID("b.ts"), defaults)
        PaletteRecents.push(t.fileID("a.ts"), defaults)
        let all = PaletteRecents.read(defaults)
        #expect(PaletteRecents.paths(all, root: t) == ["a.ts", "b.ts"])
        #expect(PaletteRecents.paths(all, root: p) == ["a.ts"])
        for i in 0..<40 { PaletteRecents.push(t.fileID("f\(i)"), defaults) }
        #expect(PaletteRecents.read(defaults).count == PaletteRecents.filesMax)
        #expect(PaletteRecents.read(defaults).first == t.fileID("f39"))
    }

    // MARK: Commands

    @Test func childrenCommandLabelFollowsThePref() {
        var prefs = Prefs.defaults
        prefs.hideChildren = true
        let s = Self.state([])
        #expect(PaletteCommands.build(s, prefs: prefs, focused: nil, canOpenFile: false).first { $0.id == "board.children" }?.label == "Show child tickets")
        prefs.hideChildren = false
        #expect(PaletteCommands.build(s, prefs: prefs, focused: nil, canOpenFile: false).first { $0.id == "board.children" }?.label == "Hide child tickets")
    }

    @Test func openFileIsAbsentWithoutARoot() {
        let s = Self.state([])
        #expect(!PaletteCommands.build(s, prefs: .defaults, focused: nil, canOpenFile: false).contains { $0.id == "open-file" })
        #expect(PaletteCommands.build(s, prefs: .defaults, focused: nil, canOpenFile: true).contains { $0.id == "open-file" })
    }

    @Test func noTicketActionsWithoutAFocusedTicket() {
        let ids = PaletteCommands.build(Self.state([]), prefs: .defaults, focused: nil, canOpenFile: false).map(\.id)
        #expect(!ids.contains { $0.hasPrefix("ticket.") })
        #expect(ids.contains("new-session") && ids.contains("project:p1") && ids.contains("inbox"))
    }

    @Test func aFocusedTicketOffersItsActionsByTheSameRulesAsItsScreen() {
        let planning = Self.ticket("1", "Plan it")
        let s = Self.state([planning])
        let cmds = PaletteCommands.ticketCommands(planning, s)
        let set = TicketActions.set(for: planning, project: s.projects["p1"], parent: nil, deps: [], settingsBaseBranch: nil)
        // One row per enabled action, then Copy ticket key; no tracker link, so no Open in source tracker.
        #expect(cmds.count == set.enabledActions.count + 1)
        #expect(cmds.map(\.label).contains("Delete ticket…"))
        #expect(cmds.last?.label == "Copy ticket key")
        #expect(!cmds.contains { $0.label == "Open in source tracker" })
        #expect(cmds.first { $0.label == "Delete ticket…" }?.destructive == true)
    }

    @Test func reviewTicketOffersApproveWaysAndRequestChanges() {
        let r = Self.ticket("2", "Ready", status: .review)
        let labels = PaletteCommands.ticketCommands(r, Self.state([r])).map(\.label)
        #expect(labels.contains("Request changes…"))
        #expect(labels.contains { $0.hasPrefix("Approve") })
        #expect(labels.contains("Re-run agent review") || labels.contains("Run agent review"))
    }

    @Test func trackerLinkAddsOpenInSourceTracker() {
        var t = Self.ticket("3", "Linked")
        t.externalRef = ExternalRef(source: "jira", key: "FOO-1", url: "https://example.com/FOO-1")
        let cmds = PaletteCommands.ticketCommands(t, Self.state([t]))
        #expect(cmds.last?.action == .openTracker(URL(string: "https://example.com/FOO-1")!))
        t.externalRef = ExternalRef(source: "manual", key: "x", url: nil)
        #expect(!PaletteCommands.ticketCommands(t, Self.state([t])).contains { $0.label == "Open in source tracker" })
    }

    // MARK: Rows

    @Test func greaterThanListsOnlyCommandsEvenWhenATicketAndAPathMatch() {
        let t = Self.ticket("9", "settings.json cleanup")
        let s = Self.state([t])
        let commands = PaletteCommands.build(s, prefs: .defaults, focused: nil, canOpenFile: true)
        let rows = PaletteRows.rows(PaletteQuery.parse("> settings"), commands: commands, state: s, searchIDs: ["9"])
        #expect(!rows.isEmpty)
        #expect(rows.allSatisfy { if case .command = $0.content { true } else { false } })
        // The same words without the prefix find the ticket too.
        let plain = PaletteRows.rows(PaletteQuery.parse("settings"), commands: commands, state: s, searchIDs: nil)
        #expect(plain.contains { if case .ticket = $0.content { true } else { false } })
    }

    @Test func hashListsOnlyTicketsAndTheServersExtraMatchesComeLast() {
        let a = Self.ticket("1", "Fix login"), b = Self.ticket("2", "Unrelated title")
        let s = Self.state([a, b])
        let commands = PaletteCommands.build(s, prefs: .defaults, focused: nil, canOpenFile: false)
        let rows = PaletteRows.rows(PaletteQuery.parse("#login"), commands: commands, state: s, searchIDs: ["2", "1"])
        #expect(rows.map { $0.id } == ["ticket:K-1", "ticket:K-2"])
    }

    @Test func anEmptyPlainQueryShowsCommandsAndNoTickets() {
        let s = Self.state([Self.ticket("1", "Fix login")])
        let rows = PaletteRows.rows(PaletteQuery.parse(""), commands: PaletteCommands.build(s, prefs: .defaults, focused: nil, canOpenFile: false), state: s, searchIDs: nil)
        #expect(!rows.contains { if case .ticket = $0.content { true } else { false } })
        #expect(!rows.isEmpty)
    }

    @Test func draftsAreNotInThePalette() {
        var d = Self.ticket("4", "Login draft")
        d.draft = true
        let s = Self.state([d])
        let rows = PaletteRows.rows(PaletteQuery.parse("login"), commands: [], state: s, searchIDs: ["4"])
        #expect(rows.isEmpty)
    }
}
