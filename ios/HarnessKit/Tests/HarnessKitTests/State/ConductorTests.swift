import Foundation
import Testing
@testable import HarnessKit

struct BoardWeight: Decodable, Sendable, Equatable {
    let isChild: Bool
    let attention: Conductor.Attention?
    let needsHuman: Bool
    let dimOnBoard: Bool
    let hideWhenHiding: Bool
    let hideWhenShowing: Bool
}

struct ChildrenOfTicketInput: Decodable, Sendable {
    let tickets: [String: Ticket]
    let conductorId: String
}

struct IsWorkingInput: Decodable, Sendable {
    let tickets: [String: Ticket]
    let ticket: Ticket
}

struct IsWorkingOutput: Decodable, Sendable, Equatable {
    let working: Bool
    let title: String
}

struct ProgressOutput: Decodable, Sendable {
    let progress: Conductor.Progress
    let label: String
    let segments: [Conductor.Segment]
}

struct DepStatesInput: Decodable, Sendable {
    let tickets: [String: Ticket]
    let ticket: Ticket
    let aliases: [String: String]?
}

struct DepStatesOutput: Decodable, Sendable, Equatable {
    struct Dep: Decodable, Sendable, Equatable {
        let key: String
        let done: Bool
        let state: DepState.Kind
        let ticketKey: String?
        let missing: Bool?
    }
    let deps: [Dep]
    let waitingOn: [String]
    let titles: [String]
}

struct ChildGroupSummary: Decodable, Sendable, Equatable {
    let status: TicketStatus
    let tickets: [String]
}

/// An in-memory KV, optionally throwing on every read and write.
final class MemoryKV: KV {
    struct Blocked: Error {}
    var items: [String: String] = [:]
    var throwing = false
    func getItem(_ key: String) throws -> String? {
        if throwing { throw Blocked() }
        return items[key]
    }
    func setItem(_ key: String, _ value: String) throws {
        if throwing { throw Blocked() }
        items[key] = value
    }
}

@Suite("state/conductor.ts parity")
struct ConductorTests {
    @Test func constants() throws {
        #expect(Conductor.hideChildrenKey == (try Fixture.value("stateConductor", "hideChildrenKey", as: String.self)))
        #expect(Conductor.hideChildrenDefault == (try Fixture.value("stateConductor", "hideChildrenDefault", as: Bool.self)))
        #expect(Conductor.segmentOrder == (try Fixture.value("stateConductor", "segmentOrder", as: [TicketStatus].self)))
    }

    @Test(arguments: Fixture.cases("stateConductor", "boardWeightCases", input: Ticket.self, output: BoardWeight.self))
    func boardWeight(_ c: Fixture.Case<Ticket, BoardWeight>) {
        let t = c.input
        let got = BoardWeight(
            isChild: Conductor.isChild(t), attention: Conductor.attentionOf(t), needsHuman: Conductor.needsHuman(t),
            dimOnBoard: Conductor.dimOnBoard(t), hideWhenHiding: Conductor.hideOnBoard(t, hideChildren: true),
            hideWhenShowing: Conductor.hideOnBoard(t, hideChildren: false)
        )
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("stateConductor", "childrenOfTicketCases", input: ChildrenOfTicketInput.self, output: [String].self))
    func childrenOfTicket(_ c: Fixture.Case<ChildrenOfTicketInput, [String]>) {
        #expect(Conductor.childrenOfTicket(c.input.tickets, conductorId: c.input.conductorId).map(\.key) == c.output)
    }

    @Test(arguments: Fixture.cases("stateConductor", "isWorkingCases", input: IsWorkingInput.self, output: IsWorkingOutput.self))
    func isWorking(_ c: Fixture.Case<IsWorkingInput, IsWorkingOutput>) {
        let got = IsWorkingOutput(working: Conductor.isWorking(c.input.tickets, c.input.ticket), title: Conductor.workingTitle(c.input.ticket))
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("stateConductor", "progressCases", input: [Ticket].self, output: ProgressOutput.self))
    func progress(_ c: Fixture.Case<[Ticket], ProgressOutput>) {
        let p = Conductor.progressOf(c.input)
        #expect(p == c.output.progress)
        #expect(Conductor.progressLabel(p) == c.output.label)
        #expect(Conductor.progressSegments(p) == c.output.segments)
    }

    @Test(arguments: Fixture.cases("stateConductor", "depStatesCases", input: DepStatesInput.self, output: DepStatesOutput.self))
    func depStates(_ c: Fixture.Case<DepStatesInput, DepStatesOutput>) {
        let deps = Conductor.depStates(c.input.tickets, c.input.ticket, aliases: c.input.aliases ?? [:])
        let got = DepStatesOutput(
            deps: deps.map { .init(key: $0.key, done: $0.done, state: $0.state, ticketKey: $0.ticket?.key, missing: $0.missing) },
            waitingOn: Conductor.waitingOn(deps),
            titles: deps.map(Conductor.depChipTitle)
        )
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("stateConductor", "depChipTitleCases", input: DepState.self, output: String.self))
    func depChipTitle(_ c: Fixture.Case<DepState, String>) {
        #expect(Conductor.depChipTitle(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateConductor", "waitingOnCases", input: [DepState].self, output: [String].self))
    func waitingOn(_ c: Fixture.Case<[DepState], [String]>) {
        #expect(Conductor.waitingOn(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateConductor", "dependencyDepthsCases", input: [Ticket].self, output: [String: Int].self))
    func dependencyDepths(_ c: Fixture.Case<[Ticket], [String: Int]>) {
        #expect(Conductor.dependencyDepths(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateConductor", "groupChildrenCases", input: [Ticket].self, output: [ChildGroupSummary].self))
    func groupChildren(_ c: Fixture.Case<[Ticket], [ChildGroupSummary]>) {
        #expect(Conductor.groupChildren(c.input).map { ChildGroupSummary(status: $0.status, tickets: $0.tickets.map(\.key)) } == c.output)
    }

    @Test func progressRoundTripsAsAStatusKeyedObject() throws {
        let p = Conductor.progressOf([])
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(p)) as? [String: Any]
        let byStatus = json?["byStatus"] as? [String: Int]
        #expect(byStatus == ["planning": 0, "in_progress": 0, "blocked": 0, "review": 0, "done": 0])
        #expect(try JSONDecoder().decode(Conductor.Progress.self, from: JSONEncoder().encode(p)) == p)
    }

    // MARK: Hide-children preference

    @Test func hideChildrenFirstRunAndExplicitChoices() {
        let kv = MemoryKV()
        #expect(Conductor.readHideChildren(kv) == true)
        Conductor.writeHideChildren(false, kv)
        #expect(kv.items[Conductor.hideChildrenKey] == "0")
        #expect(Conductor.readHideChildren(kv) == false)
        Conductor.writeHideChildren(true, kv)
        #expect(kv.items[Conductor.hideChildrenKey] == "1")
        #expect(Conductor.readHideChildren(kv) == true)
        kv.items[Conductor.hideChildrenKey] = "garbage"
        #expect(Conductor.readHideChildren(kv) == true)
        kv.items[Conductor.hideChildrenKey] = "0"
        // The v1 key (old default "shown") is ignored.
        kv.items["harness.board.hideChildren"] = "1"
        #expect(Conductor.readHideChildren(kv) == false)
    }

    @Test func hideChildrenToleratesThrowingOrMissingStorage() {
        let kv = MemoryKV()
        kv.items[Conductor.hideChildrenKey] = "0"
        kv.throwing = true
        #expect(Conductor.readHideChildren(kv) == true)
        Conductor.writeHideChildren(true, kv)
        kv.throwing = false
        #expect(kv.items[Conductor.hideChildrenKey] == "0")
        #expect(Conductor.readHideChildren(nil) == true)
        Conductor.writeHideChildren(false, nil)
    }
}
