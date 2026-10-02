import Foundation
import Testing
@testable import HarnessKit

/// DetailFetcher: fetching the ticket details the board needs (dependencies, a conductor's done
/// children, related tickets) once each and a few at a time, with a 404 remembered as missing.
@MainActor
@Suite("DetailFetcher")
struct DetailFetcherTests {
    struct Call: Sendable {
        let key: String
        let d = Deferred<TicketDetail>()
    }

    final class FakeClient: DetailClient {
        let calls = CallLog<Call>()
        func getTicket(_ key: String) async throws -> TicketDetail {
            let call = Call(key: key)
            calls.append(call)
            return try await call.d.value()
        }
    }

    nonisolated(unsafe) static var n = 0
    static func tk(_ key: String, status: TicketStatus = .planning, kind: TicketKind = .task, parentId: String? = nil, dependsOn: [String] = [], completedAt: Patch<Timestamp> = .null) -> Ticket {
        n += 1
        return Ticket(id: "id-\(key)", key: key, projectId: "p", kind: kind, title: key, description: "", status: status, sessionId: "s-\(key)", driver: "dummy",
                      parentId: parentId, dependsOn: dependsOn, completedAt: completedAt, createdAt: Double(n), updatedAt: Double(n))
    }

    static func detailOf(_ t: Ticket, children: [Ticket] = [], related: [RelatedTicket]? = nil) -> TicketDetail {
        let session = Session(id: t.sessionId, key: t.key, kind: .ticket, ticketId: t.id, driver: "dummy", cwd: "/", title: "", busy: false, createdAt: 0, updatedAt: 0)
        return TicketDetail(ticket: t, session: session, children: children, relatedTickets: related)
    }

    static func linked(_ key: String) -> RelatedTicket {
        RelatedTicket(key: key, title: key, status: .planning, projectId: "p", externalKey: "JIRA-9")
    }

    @MainActor
    final class Harness {
        var state: BoardState
        let client = FakeClient()
        var related: [String: [String]] = [:]
        var remote: [String: [String]] = [:]
        var f: DetailFetcher!

        init(_ open: [Ticket], concurrency: Int = 2) {
            state = BoardState.initial.reduced(.snapshot(BoardSnapshot(tickets: open)))
            f = DetailFetcher(
                client: client,
                dispatch: { [unowned self] in self.state.reduce($0) },
                concurrency: concurrency,
                onRelated: { [unowned self] id, list in self.related[id] = list.map(\.key) },
                onRemoteKey: { [unowned self] key, list in self.remote[key] = list.map(\.key) })
        }
    }

    @Test func anUnloadedDependencyIsFetchedOnceAndItsChipSettles() async {
        let waiting = Self.tk("A-2", dependsOn: ["A-1"])
        let h = Harness([waiting])
        #expect(h.state.dependencyStates(waiting)[0].state == .unknown)
        h.f.sync(h.state)
        h.f.sync(h.state) // a re-render before the answer
        await eventually { h.client.calls.count == 1 }
        await settle()
        #expect(h.client.calls.all.map(\.key) == ["A-1"])
        h.client.calls[0].d.resolve(Self.detailOf(Self.tk("A-1", status: .done, completedAt: .value(5))))
        await eventually { h.state.ticketByKey("A-1") != nil }
        let dep = h.state.dependencyStates(waiting)[0]
        #expect(dep.state == .done && dep.done)
        h.f.sync(h.state)
        await settle()
        #expect(h.client.calls.count == 1)
    }

    @Test func a404IsRecordedAsMissingAndNotAskedForAgain() async {
        let h = Harness([Self.tk("A-2", dependsOn: ["GONE-1"])])
        h.f.sync(h.state)
        await eventually { h.client.calls.count == 1 }
        h.client.calls[0].d.reject(HarnessAPIError(status: 404, message: "Unknown ticket"))
        await eventually { h.state.missingKeys["GONE-1"] == true }
        h.f.reset()
        h.f.sync(h.state)
        await settle()
        #expect(h.client.calls.count == 1)
        #expect(h.remote["GONE-1"] == [])
    }

    @Test func otherFailuresAreNotMissingAndComeBackAfterAReset() async {
        let h = Harness([Self.tk("A-2", dependsOn: ["X-1"])])
        h.f.sync(h.state)
        await eventually { h.client.calls.count == 1 }
        h.client.calls[0].d.reject(TestError("offline"))
        await settle()
        #expect(h.state.missingKeys.isEmpty)
        h.f.sync(h.state) // done until the next snapshot
        await settle()
        #expect(h.client.calls.count == 1)
        h.f.reset()
        h.f.sync(h.state)
        await eventually { h.client.calls.count == 2 }
    }

    @Test func aConductorsDetailFillsInItsDoneChildren() async {
        let conductor = Self.tk("C-1", status: .inProgress, kind: .conductor)
        let live = Self.tk("C-3", status: .inProgress, parentId: conductor.id)
        let h = Harness([conductor, live])
        #expect(Conductor.progressOf(h.state.childrenOf(conductor.id)).total == 1)
        h.f.sync(h.state)
        await eventually { h.client.calls.count == 1 }
        #expect(h.client.calls.all.map(\.key) == ["C-1"])
        h.client.calls[0].d.resolve(Self.detailOf(conductor, children: [Self.tk("C-2", status: .done, parentId: conductor.id, completedAt: .value(3)), live]))
        await eventually { h.state.childrenLoaded[conductor.id] == true }
        let p = Conductor.progressOf(h.state.childrenOf(conductor.id))
        #expect(p.total == 2)
        #expect(p.count(.done) == 1)
    }

    @Test func atMostConcurrencyRequestsAtATime() async {
        let h = Harness([Self.tk("X-9", dependsOn: ["X-1", "X-2", "X-3"])], concurrency: 2)
        h.f.sync(h.state)
        await eventually { h.client.calls.count == 2 }
        await settle()
        #expect(Set(h.client.calls.all.map(\.key)) == ["X-1", "X-2"])
        let first = h.client.calls.all.first { $0.key == "X-1" }!
        first.d.resolve(Self.detailOf(Self.tk("X-1", status: .done)))
        await eventually { h.client.calls.count == 3 }
        #expect(h.client.calls[2].key == "X-3")
    }

    @Test func loadSharesTheRequestAlreadyInFlight() async throws {
        let h = Harness([Self.tk("A-2", dependsOn: ["A-1"])])
        h.f.sync(h.state)
        let p = h.f.request("a-1")
        await eventually { h.client.calls.count == 1 }
        await settle()
        #expect(h.client.calls.count == 1)
        h.client.calls[0].d.resolve(Self.detailOf(Self.tk("A-1")))
        #expect(try await p.value.ticket.key == "A-1")
    }

    @Test func relatedTicketsAreHandedOverByTicketId() async throws {
        let h = Harness([])
        let a = Self.tk("MH-124")
        let p = h.f.request("MH-124")
        await eventually { h.client.calls.count == 1 }
        h.client.calls[0].d.resolve(Self.detailOf(a, related: [Self.linked("MH-130")]))
        _ = try await p.value
        #expect(h.related[a.id] == ["MH-130"])
        #expect(h.remote["MH-124"] == [])
        // An older service's detail (no relatedTickets) leaves them alone.
        let q = h.f.request("MH-124")
        await eventually { h.client.calls.count == 2 }
        h.client.calls[1].d.resolve(Self.detailOf(a))
        _ = try await q.value
        #expect(h.related[a.id] == ["MH-130"])
    }

    @Test func aRemoteOnlyKeys404HandsOverTheTicketsItPointsTo() async throws {
        let h = Harness([])
        let matches = RemoteKeyMatches(requested: "JIRA-9", relatedTickets: [Self.linked("MH-124"), Self.linked("MH-130")])
        let data = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(matches))
        let p = h.f.request("jira-9")
        await eventually { h.client.calls.count == 1 }
        h.client.calls[0].d.reject(HarnessAPIError(status: 404, message: "Unknown ticket", data: data))
        await #expect(throws: HarnessAPIError.self) { try await p.value }
        #expect(h.remote["JIRA-9"] == ["MH-124", "MH-130"])
        #expect(h.state.missingKeys["JIRA-9"] == true)
        let q = h.f.request("GONE-1")
        await eventually { h.client.calls.count == 2 }
        h.client.calls[1].d.reject(HarnessAPIError(status: 404, message: "Unknown ticket"))
        _ = try? await q.value
        #expect(h.remote["GONE-1"] == [])
    }

    @Test func remoteMatchesNeedA404WithMatches() throws {
        let empty = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"requested":"X-1","relatedTickets":[]}"#.utf8))
        #expect(DetailFetcher.remoteMatches(HarnessAPIError(status: 404, message: "", data: empty)) == nil)
        let one = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(RemoteKeyMatches(requested: "X-1", relatedTickets: [Self.linked("A-1")])))
        #expect(DetailFetcher.remoteMatches(HarnessAPIError(status: 500, message: "", data: one)) == nil)
        #expect(DetailFetcher.remoteMatches(HarnessAPIError(status: 404, message: "", data: one))?.relatedTickets.map(\.key) == ["A-1"])
        #expect(DetailFetcher.remoteMatches(TestError("x")) == nil)
    }

    @Test func wantedSkipsKeysAlreadyAskedForAndAddsExtras() async {
        let h = Harness([Self.tk("A-2", dependsOn: ["A-1", "a-1"])])
        #expect(h.f.wanted(h.state, extra: ["Z-9", "A-2"]) == ["A-1", "Z-9"])
        h.f.sync(h.state, extra: ["Z-9"])
        #expect(h.f.wanted(h.state, extra: ["Z-9"]) == [])
    }
}
