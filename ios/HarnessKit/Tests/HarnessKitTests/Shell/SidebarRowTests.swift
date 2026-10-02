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

    @Test func highlightFollowsTheSectionAndTheBoardsFilter() {
        let exists: (String) -> Bool = { $0 == "p1" }
        #expect(SidebarRow.current(tab: .inbox, boardProject: "p1", projectExists: exists) == .inbox)
        #expect(SidebarRow.current(tab: .settings, boardProject: "p1", projectExists: exists) == .settings)
        #expect(SidebarRow.current(tab: .board, boardProject: "p1", projectExists: exists) == .project("p1"))
        #expect(SidebarRow.current(tab: .board, boardProject: nil, projectExists: exists) == .allProjects)
    }

    /// A deleted project's filter shows All projects on the board, so that row is the one lit.
    @Test func aGoneProjectHighlightsAllProjects() {
        #expect(SidebarRow.current(tab: .board, boardProject: "deleted", projectExists: { _ in false }) == .allProjects)
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
        #expect(SidebarRow.current(tab: r.selectedTab, boardProject: app.prefs.boardProject, projectExists: { _ in true }) == .inbox)
    }
}
