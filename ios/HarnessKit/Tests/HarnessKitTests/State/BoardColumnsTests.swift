import Foundation
import Testing
@testable import HarnessKit

@Suite("mobile boardColumns.ts parity")
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

    struct MoveInput: Decodable, Sendable {
        let t: Ticket
        let status: TicketStatus
        let `where`: BoardColumns.Where
        let cols: Columns
        let now: Double
    }

    @Test(arguments: Fixture.cases("mobileBoardColumns", "moveBodyCases", input: MoveInput.self, output: BoardColumns.Move?.self))
    func moveBody(_ c: Fixture.Case<MoveInput, BoardColumns.Move?>) {
        let i = c.input
        #expect(BoardColumns.moveBody(i.t, to: i.status, i.where, cols: i.cols, now: i.now) == c.output)
    }

    @Test func appliedMoveIsTheOptimisticCopy() throws {
        let t = Ticket(id: "a", key: "A-1", projectId: "p1", title: "a", description: "", status: .done, sessionId: "s", driver: "d",
                       position: 4, completedAt: .value(50), createdAt: 1, updatedAt: 1)
        let move = try #require(BoardColumns.moveBody(t, to: .planning, .top, cols: Columns(), now: 99))
        let next = move.applied(to: t)
        #expect(next.status == .planning)
        #expect(next.position == 0)
        #expect(next.completedAt == .null)
        #expect(move.updateBody.status == .planning)
        #expect(move.updateBody.position == 0)
    }
}
