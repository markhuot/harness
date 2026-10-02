import Foundation
import Synchronization
import Testing
@testable import HarnessKit

/// BoardStore's connection policy, driven with a fake service, socket and clock.
@MainActor
@Suite("BoardStore")
struct BoardStoreTests {
    /// A fake service: canned answers, a log of every call, and optional failures.
    final class FakeClient: BoardClient {
        struct State {
            var projects: [Project] = []
            var live: [Ticket] = []
            var donePage: TicketPage? = TicketPage(tickets: [], nextCursor: nil, total: 0)
            var pageError: (any Error)?
            var snapshotError: (any Error)?
            var summaryHold: [String: Deferred<[Summary]>] = [:]
            var details: [String: TicketDetail] = [:]
        }

        let s = Mutex(State())
        let calls = CallLog<String>()
        let inFlightSummaries = Mutex((now: 0, max: 0))

        func listProjects() async throws -> [Project] {
            calls.append("projects")
            if let e = s.withLock({ $0.snapshotError }) { throw e }
            return s.withLock { $0.projects }
        }

        func listTickets(projectId: String?, status: [TicketStatus]) async throws -> [Ticket] {
            calls.append("tickets \(status.map(\.rawValue).joined(separator: ","))")
            return s.withLock { $0.live }
        }

        func ticketPage(status: TicketStatus, projectId: String?, q: String?, limit: Int?, cursor: String?) async throws -> TicketPage {
            calls.append("page \(status.rawValue) \(projectId ?? "*") \(limit.map(String.init) ?? "-") \(cursor ?? "-")")
            let (page, error) = s.withLock { ($0.donePage, $0.pageError) }
            if let error { throw error }
            return page ?? TicketPage(tickets: [], nextCursor: nil, total: 0)
        }

        func searchTickets(q: String, projectId: String?, limit: Int?, cursor: String?) async throws -> TicketPage {
            calls.append("search \(q)")
            return TicketPage(tickets: [], nextCursor: nil, total: 0)
        }

        func getTicket(_ key: String) async throws -> TicketDetail {
            calls.append("detail \(key)")
            if let d = s.withLock({ $0.details[key.uppercased()] }) { return d }
            throw HarnessAPIError(status: 404, message: "Unknown ticket")
        }

        func listSessions(kind: SessionKind?) async throws -> [Session] {
            calls.append("sessions")
            return []
        }

        func listWatchers() async throws -> [Watcher] {
            calls.append("watchers")
            throw TestError("watchers unsupported") // optional: the snapshot carries on with []
        }

        func getSettings() async throws -> PublicSettings {
            calls.append("settings")
            throw TestError("settings unsupported")
        }

        func listDrivers() async throws -> [DriverInfo] {
            calls.append("drivers")
            return []
        }

        func listSummaries(_ key: String) async throws -> [Summary] {
            calls.append("summaries \(key)")
            inFlightSummaries.withLock { $0.now += 1; $0.max = max($0.max, $0.now) }
            defer { inFlightSummaries.withLock { $0.now -= 1 } }
            if let hold = s.withLock({ $0.summaryHold[key] }) { return try await hold.value() }
            return [Summary(id: "sum-\(key)", sessionId: "s-\(key)", author: .agent, body: key, createdAt: 1)]
        }

        func count(_ prefix: String) -> Int { calls.all.filter { $0.hasPrefix(prefix) }.count }
    }

    final class FakeSocket: EventSource {
        let events: AsyncStream<HarnessEvent>
        let status: AsyncStream<Bool>
        private let eventsOut: AsyncStream<HarnessEvent>.Continuation
        private let statusOut: AsyncStream<Bool>.Continuation
        let closed = Mutex(false)

        init() {
            (events, eventsOut) = AsyncStream.makeStream()
            (status, statusOut) = AsyncStream.makeStream()
        }

        func emit(_ e: HarnessEvent) { eventsOut.yield(e) }
        func connect(_ up: Bool) { statusOut.yield(up) }
        func close() async {
            closed.withLock { $0 = true }
            eventsOut.finish()
            statusOut.finish()
        }
    }

    @MainActor
    final class Harness {
        let client = FakeClient()
        let clock = ManualTimers()
        var sockets: [FakeSocket] = []
        var store: BoardStore!

        init(boardProject: String? = nil) {
            store = BoardStore(client: client, baseUrl: "http://mac:7717", boardProject: boardProject, makeSocket: { [unowned self] in
                let s = FakeSocket()
                self.sockets.append(s)
                return s
            }, timers: clock)
        }

        var socket: FakeSocket { sockets.last! }
    }

    static func tk(_ id: String, status: TicketStatus = .inProgress, completedAt: Double? = nil, dependsOn: [String] = []) -> Ticket {
        Ticket(id: id, key: id.uppercased(), projectId: "p1", title: id, description: "", status: status, sessionId: "s-\(id.uppercased())", driver: "dummy",
               dependsOn: dependsOn, completedAt: completedAt.map { .value($0) } ?? .null, createdAt: 1, updatedAt: 1)
    }

    @Test func everyConnectFetchesTheSnapshotAndBackfillsSummaries() async {
        let h = Harness(boardProject: "p1")
        let done = (0..<15).map { Self.tk("d\($0)", status: .done, completedAt: Double(100 - $0)) }
        h.client.s.withLock {
            $0.live = [Self.tk("w1"), Self.tk("w2", status: .review)]
            $0.donePage = TicketPage(tickets: done, nextCursor: "c", total: 40)
        }
        h.store.start()
        #expect(!h.store.state.ready)
        h.socket.connect(true)
        await eventually { h.store.state.ready && h.client.count("summaries") == 14 }
        #expect(h.store.state.connected)
        #expect(h.client.calls.all.contains("tickets planning,in_progress,blocked,review"))
        #expect(h.client.calls.all.contains("page done p1 50 -"))
        #expect(h.store.state.donePaging["p1"]?.total == 40)
        #expect(h.store.state.watchers.isEmpty && h.store.state.settings == nil) // optional calls failed, snapshot still applied
        // Every non-done ticket plus the 12 newest done ones.
        await settle()
        let asked = Set(h.client.calls.all.filter { $0.hasPrefix("summaries") })
        let expected = (["W1", "W2"] + (0..<12).map { "D\($0)" }).map { "summaries \($0)" }
        #expect(asked == Set(expected))
        #expect(h.store.state.latestSummary("s-W1")?.id == "sum-W1")
        #expect(h.store.epoch == 0)
        #expect(h.store.loadError == nil)
    }

    @Test func summaryBackfillRunsAtMostSixAtATime() async {
        let h = Harness()
        let live = (0..<10).map { Self.tk("t\($0)") }
        let holds = Dictionary(uniqueKeysWithValues: live.map { ($0.key, Deferred<[Summary]>()) })
        h.client.s.withLock {
            $0.live = live
            $0.summaryHold = holds
        }
        h.store.start()
        h.socket.connect(true)
        await eventually { h.client.count("summaries") == 6 }
        await settle()
        #expect(h.client.count("summaries") == 6)
        for d in holds.values { d.resolve([]) }
        await eventually { h.client.count("summaries") == 10 }
        #expect(h.client.inFlightSummaries.withLock { $0.max } == 6)
    }

    @Test func refreshReturnsOnceTheSnapshotLandsWithoutWaitingForSummaries() async {
        let h = Harness()
        let never = Deferred<[Summary]>() // never settled
        h.client.s.withLock {
            $0.live = [Self.tk("w1")]
            $0.summaryHold = ["W1": never]
        }
        var returned = false
        let refresh = Task { await h.store.refresh(); returned = true }
        await eventually { h.client.count("summaries W1") == 1 }
        // A refresh that waited on the backfill would still be pending here.
        let finished = await eventually({ returned }, timeout: .milliseconds(500))
        #expect(finished)
        #expect(h.store.state.ready)
        #expect(!never.isSettled)
        #expect(h.store.state.summaries["s-W1"] == nil)
        never.resolve([]) // let the backfill (and a waiting refresh) finish
        await refresh.value
    }

    @Test func reconnectsBumpTheEpochButTheFirstConnectDoesNot() async {
        let h = Harness()
        h.store.start()
        h.socket.connect(true)
        await eventually { h.store.state.ready }
        #expect(h.store.epoch == 0)
        h.socket.connect(false)
        await eventually { !h.store.state.connected }
        h.socket.connect(true)
        await eventually { h.store.epoch == 1 }
        await eventually { h.client.count("projects") == 2 }
        h.socket.connect(false)
        h.socket.connect(true)
        await eventually { h.store.epoch == 2 }
        await eventually { h.client.count("projects") == 3 }
    }

    @Test func aRestSnapshotLoadsWhenTheSocketHasNotConnectedAfterOneAndAHalfSeconds() async {
        let h = Harness()
        h.store.start()
        h.clock.advance(by: 1499)
        await settle()
        #expect(h.client.count("projects") == 0)
        h.clock.advance(by: 1)
        await eventually { h.store.state.ready }
        #expect(!h.store.state.connected)
        #expect(h.client.count("projects") == 1)
    }

    @Test func noRestFallbackOnceTheSocketDeliveredASnapshot() async {
        let h = Harness()
        h.store.start()
        h.socket.connect(true)
        await eventually { h.store.state.ready }
        h.clock.advance(by: 1500)
        await settle()
        #expect(h.client.count("projects") == 1)
    }

    @Test func whileDisconnectedTheSnapshotIsPolledEveryEightSeconds() async {
        let h = Harness()
        h.store.start()
        h.clock.advance(by: 1500) // the REST fallback
        await eventually { h.client.count("projects") == 1 }
        h.clock.advance(by: 6499)
        await settle()
        #expect(h.client.count("projects") == 1)
        h.clock.advance(by: 1) // 8 s after start
        await eventually { h.client.count("projects") == 2 }
        h.clock.advance(by: 8000)
        await eventually { h.client.count("projects") == 3 }
        // Connected: polling stops.
        h.socket.connect(true)
        await eventually { h.client.count("projects") == 4 }
        h.clock.advance(by: 24_000)
        await settle()
        #expect(h.client.count("projects") == 4)
        #expect(h.clock.count == 0)
        // Dropped again: it resumes.
        h.socket.connect(false)
        await eventually { !h.store.state.connected }
        #expect(h.clock.delays == [8000])
        h.clock.advance(by: 8000)
        await eventually { h.client.count("projects") == 5 }
    }

    @Test func a401SurfacesAsAnAuthErrorAndASuccessClearsIt() async {
        let h = Harness()
        h.client.s.withLock { $0.snapshotError = HarnessAPIError(status: 401, message: "Unauthorized") }
        h.store.start()
        await h.store.refresh()
        #expect(h.store.authError == Connection.unauthorizedMessage)
        #expect(h.store.loadError == nil)
        #expect(!h.store.state.ready)
        h.client.s.withLock { $0.snapshotError = nil }
        await h.store.refresh()
        #expect(h.store.authError == nil)
        #expect(h.store.state.ready)
    }

    @Test func otherFailuresAreLoadErrors() async {
        let h = Harness()
        h.client.s.withLock { $0.snapshotError = URLError(.cannotConnectToHost) }
        await h.store.refresh()
        #expect(h.store.authError == nil)
        #expect(h.store.loadError == Connection.unreachableMessage("http://mac:7717"))
    }

    @Test func aServiceWithoutPagingFallsBackToTheLegacySnapshot() async {
        let h = Harness()
        h.client.s.withLock {
            $0.live = [Self.tk("w1"), Self.tk("old", status: .done, completedAt: 5)]
            $0.pageError = HarnessAPIError(status: 404, message: "Not found")
        }
        await h.store.refresh()
        #expect(h.store.state.ready)
        #expect(h.store.state.donePaging.isEmpty)
        #expect(h.store.loader.legacy)
        #expect(h.store.state.boardColumns(nil).done.map(\.id) == ["old"])
        #expect(h.store.loader.ensureFirstPage("p2") == nil)
        await eventually { h.client.count("summaries") == 2 }
    }

    @Test func aFailingDonePageOtherThan404FailsTheSnapshot() async {
        let h = Harness()
        h.client.s.withLock { $0.pageError = HarnessAPIError(status: 500, message: "boom") }
        await h.store.refresh()
        #expect(!h.store.state.ready)
        #expect(h.store.loadError == "boom")
    }

    @Test func browserEventsBypassTheReducerAndReachListeners() async {
        let h = Harness()
        var seen: [String] = []
        let stop = h.store.onEvent { seen.append($0.kind) }
        h.store.start()
        h.socket.emit(.browserFrame(sessionId: "s", data: "AAAA", width: 1, height: 1))
        h.socket.emit(.ticketUpserted(ticket: Self.tk("live")))
        await eventually { seen.count == 2 }
        #expect(seen == ["browser.frame", "ticket.upserted"])
        #expect(h.store.state.tickets["live"] != nil)
        stop()
        h.socket.emit(.ticketDeleted(id: "live"))
        await eventually { h.store.state.tickets["live"] == nil }
        #expect(seen.count == 2)
    }

    @Test func foregroundingRebuildsADisconnectedSocketAndRefreshesAConnectedOne() async {
        let h = Harness()
        h.store.start()
        #expect(h.sockets.count == 1)
        h.store.sceneBecameActive() // never backgrounded: nothing
        #expect(h.sockets.count == 1)
        h.store.sceneDidEnterBackground()
        h.store.sceneBecameActive()
        #expect(h.sockets.count == 2)
        await eventually { h.sockets[0].closed.withLock { $0 } }
        // The rebuilt socket connects: a snapshot, and (a new socket's first connect) no epoch bump.
        h.socket.connect(true)
        await eventually { h.store.state.connected && h.client.count("projects") == 1 }
        #expect(h.store.epoch == 0)
        h.store.sceneDidEnterBackground()
        h.store.sceneBecameActive()
        #expect(h.sockets.count == 2)
        await eventually { h.client.count("projects") == 2 }
    }

    @Test func theBoardScopePicksTheSnapshotsDonePageAndFetchesAFirstPage() async {
        let h = Harness()
        await h.store.refresh()
        #expect(h.client.calls.all.contains("page done * 50 -"))
        h.store.setBoardScope("p2")
        await eventually { h.client.calls.all.contains("page done p2 50 -") }
        await eventually { h.store.state.donePaging["p2"] != nil }
        h.store.setBoardScope("p2") // already paged
        await settle()
        #expect(h.client.count("page done p2") == 1)
        await h.store.refresh()
        #expect(h.client.count("page done p2") == 2)
        #expect(Array(h.store.state.donePaging.keys) == ["p2"])
    }

    @Test func unresolvedKeysAndWatchedKeysAreFetched() async {
        let h = Harness()
        let dep = Self.tk("a1", status: .done, completedAt: 3)
        h.client.s.withLock {
            $0.live = [Self.tk("w1", dependsOn: ["A1"])]
            $0.details["A1"] = TicketDetail(ticket: dep, session: Session(id: dep.sessionId, key: dep.key, kind: .ticket, driver: "dummy", cwd: "/", createdAt: 0, updatedAt: 0))
        }
        await h.store.refresh()
        await eventually { h.store.state.ticketByKey("A1") != nil }
        #expect(h.store.state.dependencyStates(h.store.state.tickets["w1"]!)[0].state == .done)
        let stop = h.store.watchKey("ZZ-9")
        await eventually { h.store.state.missingKeys["ZZ-9"] == true }
        stop()
        stop()
        #expect(h.client.count("detail ZZ-9") == 1)
        #expect(try! await h.store.loadDetail("a1").ticket.id == "a1")
    }

    @Test func closeStopsTheSocketAndPolling() async {
        let h = Harness()
        h.store.start()
        h.store.close()
        await eventually { h.socket.closed.withLock { $0 } }
        #expect(h.clock.count == 0)
        h.clock.advance(by: 20_000)
        await settle()
        #expect(h.client.count("projects") == 0)
    }

    @Test func onlyKeyRelevantActionsResyncDetails() {
        #expect(BoardStore.affectsKeys(.event(.ticketUpserted(ticket: Self.tk("a")))))
        #expect(BoardStore.affectsKeys(.missingKeys(["A"])))
        #expect(!BoardStore.affectsKeys(.event(.transcriptDelta(sessionId: "s", runId: "r", text: "x"))))
        #expect(!BoardStore.affectsKeys(.connected(true)))
    }
}
