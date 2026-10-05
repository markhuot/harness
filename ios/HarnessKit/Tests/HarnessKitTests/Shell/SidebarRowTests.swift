import Foundation
import Testing
@testable import HarnessKit

/// The Projects sidebar's rows: the highlight for where the app is, and where a row goes.
@MainActor
@Suite("SidebarRow")
struct SidebarRowTests {
    static func app() -> (AppModel, MemoryStorage) {
        let storage = MemoryStorage()
        let m = AppModel(storage: storage, makeStore: nil)
        m.load()
        return (m, storage)
    }

    static func state(_ projects: Project...) -> BoardState {
        var s = BoardState.initial
        for p in projects { s.projects[p.id] = p }
        return s
    }

    static func project(_ id: String, group: String? = nil) -> Project {
        Project(id: id, key: id.uppercased(), name: id, path: "/\(id)", nextSeq: 1, useWorktrees: false, group: group, createdAt: 1, updatedAt: 1)
    }

    @Test func highlightFollowsTheSectionAndTheBoardsFilter() {
        let s = Self.state(Self.project("p1", group: "Work"))
        #expect(SidebarRow.current(tab: .inbox, board: s.boardFilter("p1")) == .inbox)
        #expect(SidebarRow.current(tab: .settings, board: s.boardFilter("p1")) == .settings)
        #expect(SidebarRow.current(tab: .board, board: s.boardFilter("p1")) == .project("p1"))
        #expect(SidebarRow.current(tab: .board, board: s.boardFilter(nil)) == .allProjects)
        #expect(SidebarRow.current(tab: .board, board: s.boardFilter("group:Work")) == .group("Work"))
    }

    /// A deleted project's filter, or a group no project carries any more, shows All projects on
    /// the board, so that row is the one lit.
    @Test func aGoneProjectOrGroupHighlightsAllProjects() {
        let s = Self.state(Self.project("p1", group: "Work"))
        #expect(SidebarRow.current(tab: .board, board: s.boardFilter("deleted")) == .allProjects)
        #expect(SidebarRow.current(tab: .board, board: s.boardFilter("group:Home")) == .allProjects)
        // Group names match exactly here: the service keeps one spelling per group.
        #expect(s.boardFilter("group:work") == nil)
        #expect(s.boardFilter("") == nil)
    }

    @Test func aGroupRowSavesTheGroupsBoardAndItSurvivesARelaunch() throws {
        let (app, storage) = Self.app()
        let r = Router()
        r.select(.group("Side projects"), app: app)
        #expect(r.selectedTab == .board && app.prefs.boardProject == "group:Side projects")
        #expect(Prefs.normalize(data: try #require(storage.snapshot[StorageKeys.prefs]).data(using: .utf8)).boardProject == "group:Side projects")
        // A project row replaces it.
        r.select(.project("p1"), app: app)
        #expect(app.prefs.boardProject == "p1")
    }

    @Test func aProjectRowFiltersTheBoardAndPopsItToItsRoot() throws {
        let (app, storage) = Self.app()
        let r = Router(selectedTab: .inbox)
        r.open(.tab(.board))
        r.push(.ticket(key: "A-1", tab: nil))
        r.open(.tab(.inbox))
        r.present(.projects)
        r.select(.project("p1"), app: app)
        #expect(r.selectedTab == .board && r.path(.board).isEmpty && r.sheet == nil)
        #expect(app.prefs.boardProject == "p1")
        // Saved, so the filter survives a relaunch.
        #expect(Prefs.normalize(data: try #require(storage.snapshot[StorageKeys.prefs]).data(using: .utf8)).boardProject == "p1")
        r.select(.allProjects, app: app)
        #expect(app.prefs.boardProject == nil && r.selectedTab == .board)
    }

    /// Inbox and Settings switch the section but keep the board's filter for coming back.
    @Test func sectionRowsKeepTheBoardsFilter() {
        let (app, _) = Self.app()
        let r = Router()
        r.select(.project("p1"), app: app)
        r.select(.settings, app: app)
        #expect(r.selectedTab == .settings && app.prefs.boardProject == "p1")
        r.select(.inbox, app: app)
        #expect(r.selectedTab == .inbox && app.prefs.boardProject == "p1")
        #expect(SidebarRow.current(tab: r.selectedTab, board: app.prefs.boardProject) == .inbox)
    }
}
