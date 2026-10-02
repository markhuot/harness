import Foundation

/// A row of the Projects sidebar (the phone's Projects sheet, the iPad's sidebar column): where
/// it takes the app, and which row is highlighted for where the app is.
public enum SidebarRow: Hashable, Sendable {
    case inbox
    case allProjects
    case project(String)
    case settings

    /// The highlighted row: the section, and on the board its project filter. A filter whose
    /// project is gone reads as All projects, as the board itself does (BoardContext).
    public static func current(tab: AppTab, boardProject: String?, projectExists: (String) -> Bool) -> SidebarRow {
        switch tab {
        case .inbox: .inbox
        case .settings: .settings
        case .board: boardProject.flatMap { projectExists($0) ? .project($0) : nil } ?? .allProjects
        }
    }

    public var tab: AppTab {
        switch self {
        case .inbox: .inbox
        case .settings: .settings
        case .allProjects, .project: .board
        }
    }
}

extension Router {
    /// Goes where a sidebar row points: its section at the root, modals dismissed, and for a board
    /// row the project filter saved first.
    public func select(_ row: SidebarRow, app: AppModel) {
        switch row {
        case .allProjects: app.setPref(\.boardProject, nil)
        case let .project(id): app.setPref(\.boardProject, id)
        case .inbox, .settings: break
        }
        open(.tab(row.tab))
    }
}
