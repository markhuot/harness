import Foundation

// What the board shows, apart from the screen —
// the columns once "Show child tickets" is applied, and each column header's count.

public enum BoardColumns {
    /// The board's columns as shown: children hidden while the pref says so (never one that needs the human).
    public static func visibleColumns(_ board: Columns, hideChildren: Bool) -> Columns {
        var out = Columns()
        for s in TicketStatus.allKnown { out[s] = board[s].filter { !Conductor.hideOnBoard($0, hideChildren: hideChildren) } }
        return out
    }

    /// The columns the board shows for `filter` (BoardState.boardFilter): search results while a
    /// search is active (children included), else `board` (state.boardColumns(filter), passed in
    /// when the caller has it) with children hidden per the pref. `pending`: the search's server
    /// results haven't landed. BoardScreen draws these; presence reports their tickets.
    public static func shownColumns(_ state: BoardState, filter: String?, board: Columns? = nil, hideChildren: Bool, sort: BoardSort = .created) -> (columns: Columns, pending: Bool) {
        if state.search != nil { return Paging.searchColumns(state, filter, sort: sort) }
        return (visibleColumns(board ?? state.boardColumns(filter, sort: sort), hideChildren: hideChildren), false)
    }

    /// Whether "Group by project" applies: the pref is on and the board spans projects (All
    /// projects or a group's board, not one project's).
    public static func groupsByProject(_ state: BoardState, filter: String?, prefs: Prefs) -> Bool {
        prefs.groupByProject == true && filter.flatMap { state.projects[$0] } == nil
    }

    /// Each column in "Group by project" order: its sections' cards one after another
    /// (BoardOrder.sectionsByProject), so paging and presence walk them as they're drawn.
    public static func grouped(_ cols: Columns, projects: [String: Project]) -> Columns {
        var out = Columns()
        for s in TicketStatus.allKnown { out[s] = BoardOrder.sectionsByProject(projects, cols[s]).flatMap(\.tickets) }
        return out
    }

    /// Every ticket key on the board as `prefs` filters it, column by column.
    public static func shownKeys(_ state: BoardState, prefs: Prefs) -> [String] {
        let cols = shownColumns(state, filter: state.boardFilter(prefs.boardProject), hideChildren: prefs.hideChildren, sort: prefs.sort).columns
        return TicketStatus.allKnown.flatMap { cols[$0].map(\.key) }
    }

    /// A column header's count. Done shows the server's total when it's paged, hidden children
    /// included, since the rest of the history isn't loaded to filter; search results count what's shown.
    public static func columnCount(_ state: BoardState, _ projectId: String?, shown: Columns, status: TicketStatus, searching: Bool) -> Int {
        !searching && status == .done ? Paging.doneCount(state, projectId, loaded: shown.done.count) : shown[status].count
    }
}
