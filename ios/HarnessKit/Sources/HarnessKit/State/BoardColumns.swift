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

    /// A column header's count. Done shows the server's total when it's paged, hidden children
    /// included, since the rest of the history isn't loaded to filter; search results count what's shown.
    public static func columnCount(_ state: BoardState, _ projectId: String?, shown: Columns, status: TicketStatus, searching: Bool) -> Int {
        !searching && status == .done ? Paging.doneCount(state, projectId, loaded: shown.done.count) : shown[status].count
    }
}
