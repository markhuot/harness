import Foundation

// Port of mobile/src/lib/boardColumns.ts: what the board shows and sends, apart from the screen —
// the columns once "Show child tickets" is applied, each column header's count, and the update a
// card move makes.

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

    /// Where a card goes in its new column.
    public enum Where: String, Codable, Sendable {
        case top, bottom
    }

    public struct Move: Codable, Sendable, Equatable {
        /// The PATCH body: the new status and/or position.
        public struct Body: Codable, Sendable, Equatable {
            public var status: TicketStatus?
            public var position: Double?
            public init(status: TicketStatus? = nil, position: Double? = nil) {
                self.status = status
                self.position = position
            }
        }

        public var body: Body
        /// The optimistic completedAt: a card dropped into Done is the newest completion.
        public var completedAt: Patch<Timestamp>

        public init(body: Body, completedAt: Patch<Timestamp>) {
            self.body = body
            self.completedAt = completedAt
        }

        /// The body as an UpdateTicketBody for HarnessClient.updateTicket.
        public var updateBody: UpdateTicketBody {
            var b = UpdateTicketBody()
            b.status = body.status
            b.position = body.position
            return b
        }

        /// `t` as it looks once the move lands (the optimistic copy to show meanwhile).
        public func applied(to t: Ticket) -> Ticket {
            var next = t
            if let s = body.status { next.status = s }
            if let p = body.position { next.position = p }
            next.completedAt = completedAt
            return next
        }
    }

    /// The update for moving `t` to the top or bottom of `status` (`cols` is the unfiltered board),
    /// or nil when nothing would change. Done is ordered by completion, so a move there sends no position.
    public static func moveBody(_ t: Ticket, to status: TicketStatus, _ where: Where, cols: Columns, now: Timestamp = Date().timeIntervalSince1970 * 1000) -> Move? {
        let others = cols[status].filter { $0.id != t.id }
        let position = status == .done ? nil : BoardState.positionForDrop(others, index: `where` == .top ? 0 : others.count)
        let body = Move.Body(status: t.status != status ? status : nil, position: position)
        if body.status == nil && body.position == nil { return nil }
        let completedAt: Patch<Timestamp> = t.status == status ? t.completedAt : status == .done ? .value(now) : .null
        return Move(body: body, completedAt: completedAt)
    }
}
