import Foundation

/// A row of the Projects sidebar (the phone's Projects sheet, the iPad's sidebar column): where
/// it takes the app, and which row is highlighted for where the app is.
public enum SidebarRow: Hashable, Sendable {
    case inbox
    case allProjects
    /// A project group's board, by the group's name
    case group(String)
    case project(String)
    case settings

    /// The highlighted row: the section, and on the board its filter as the board resolves it
    /// (`BoardState.boardFilter`: a filter whose project or group is gone reads as All projects).
    public static func current(tab: AppTab, board: String?) -> SidebarRow {
        switch tab {
        case .inbox: .inbox
        case .settings: .settings
        case .board: board.map { b in Paging.scopeGroup(b).map(SidebarRow.group) ?? .project(b) } ?? .allProjects
        }
    }

    /// The board filter the row saves (prefs.boardProject): a project id, a group's scope, or nil.
    public var board: String? {
        switch self {
        case let .group(name): Paging.groupScope(name)
        case let .project(id): id
        case .inbox, .allProjects, .settings: nil
        }
    }

    public var tab: AppTab {
        switch self {
        case .inbox: .inbox
        case .settings: .settings
        case .allProjects, .group, .project: .board
        }
    }
}

extension Router {
    /// Goes where a sidebar row points: its section at the root, modals dismissed, and for a board
    /// row its filter saved first.
    public func select(_ row: SidebarRow, app: AppModel) {
        if row.tab == .board { app.setPref(\.boardProject, row.board) }
        open(.tab(row.tab))
    }
}
