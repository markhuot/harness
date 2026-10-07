import Foundation
import Testing
@testable import HarnessKit

@Suite("BoardColumns")
struct BoardColumnsTests {
    static func state(_ actions: [BoardAction]) -> BoardState {
        actions.reduce(into: BoardState.initial) { $0.reduce($1) }
    }

    static func ids(_ c: Columns) -> [String: [String]] {
        ["planning": c.planning.map(\.id), "in_progress": c.inProgress.map(\.id), "blocked": c.blocked.map(\.id), "review": c.review.map(\.id), "done": c.done.map(\.id)]
    }

    struct VisibleInput: Decodable, Sendable {
        let actions: [BoardAction]
        let hideChildren: Bool
    }

    @Test(arguments: Fixture.cases("mobileBoardColumns", "visibleColumnsCases", input: VisibleInput.self, output: [String: [String]].self))
    func visibleColumns(_ c: Fixture.Case<VisibleInput, [String: [String]]>) {
        let board = Self.state(c.input.actions).boardColumns("p1")
        #expect(Self.ids(BoardColumns.visibleColumns(board, hideChildren: c.input.hideChildren)) == c.output)
    }

    struct CountInput: Decodable, Sendable {
        let actions: [BoardAction]
        let projectId: String?
        let status: TicketStatus
        let searching: Bool
        let hideChildren: Bool
    }

    @Test(arguments: Fixture.cases("mobileBoardColumns", "columnCountCases", input: CountInput.self, output: Int.self))
    func columnCount(_ c: Fixture.Case<CountInput, Int>) {
        let s = Self.state(c.input.actions)
        let shown = BoardColumns.visibleColumns(s.boardColumns(c.input.projectId), hideChildren: c.input.hideChildren)
        #expect(BoardColumns.columnCount(s, c.input.projectId, shown: shown, status: c.input.status, searching: c.input.searching) == c.output)
    }
}
