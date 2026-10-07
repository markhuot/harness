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
    public static func shownColumns(_ state: BoardState, filter: String?, board: Columns? = nil, hideChildren: Bool) -> (columns: Columns, pending: Bool) {
        if state.search != nil { return Paging.searchColumns(state, filter) }
        return (visibleColumns(board ?? state.boardColumns(filter), hideChildren: hideChildren), false)
    }

    /// Every ticket key on the board as `prefs` filters it, column by column.
    public static func shownKeys(_ state: BoardState, prefs: Prefs) -> [String] {
        let cols = shownColumns(state, filter: state.boardFilter(prefs.boardProject), hideChildren: prefs.hideChildren).columns
        return TicketStatus.allKnown.flatMap { cols[$0].map(\.key) }
    }

    /// A column header's count. Done shows the server's total when it's paged, hidden children
    /// included, since the rest of the history isn't loaded to filter; search results count what's shown.
    public static func columnCount(_ state: BoardState, _ projectId: String?, shown: Columns, status: TicketStatus, searching: Bool) -> Int {
        !searching && status == .done ? Paging.doneCount(state, projectId, loaded: shown.done.count) : shown[status].count
    }
}
