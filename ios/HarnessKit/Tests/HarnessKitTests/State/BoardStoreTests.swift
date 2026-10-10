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
            var activityHold: [String: Deferred<[ActivityEntry]>] = [:]
            var details: [String: TicketDetail] = [:]
            var health: Health? = Health(version: "0.1.0", pid: 1)
            var usage: PlanUsageReport?
        }

        let s = Mutex(State())
        let calls = CallLog<String>()
        let inFlightActivity = Mutex((now: 0, max: 0))

        func health() async throws -> Health {
            calls.append("health")
            if let h = s.withLock({ $0.health }) { return h }
            throw URLError(.cannotConnectToHost)
        }

        func getUsage() async throws -> PlanUsageReport {
            calls.append("usage")
            if let u = s.withLock({ $0.usage }) { return u }
            throw URLError(.cannotConnectToHost)
        }

        func listProjects() async throws -> [Project] {
            calls.append("projects")
            if let e = s.withLock({ $0.snapshotError }) { throw e }
            return s.withLock { $0.projects }
        }

        func listTickets(projectId: String?, status: [TicketStatus]) async throws -> [Ticket] {
            calls.append("tickets \(status.map(\.rawValue).joined(separator: ","))")
            return s.withLock { $0.live }
        }

        func ticketPage(status: TicketStatus, projectId: String?, group: String?, q: String?, limit: Int?, cursor: String?) async throws -> TicketPage {
            calls.append("page \(status.rawValue) \(group.map { "group=\($0)" } ?? projectId ?? "*") \(limit.map(String.init) ?? "-") \(cursor ?? "-")")
            let (page, error) = s.withLock { ($0.donePage, $0.pageError) }
            if let error { throw error }
            return page ?? TicketPage(tickets: [], nextCursor: nil, total: 0)
        }

        func searchTickets(q: String, projectId: String?, group: String?, limit: Int?, cursor: String?) async throws -> TicketPage {
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

        func listActivity(_ key: String) async throws -> [ActivityEntry] {
            calls.append("activity \(key)")
            inFlightActivity.withLock { $0.now += 1; $0.max = max($0.max, $0.now) }
            defer { inFlightActivity.withLock { $0.now -= 1 } }
            if let hold = s.withLock({ $0.activityHold[key] }) { return try await hold.value() }
            return [ActivityEntry(id: "act-\(key)", sessionId: "s-\(key)", author: .agent, body: key, createdAt: 1)]
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
        Ticket(id: id, key: id.uppercased(), projectId: "p1", title: id, spec: "", status: status, sessionId: "s-\(id.uppercased())", driver: "dummy",
               dependsOn: dependsOn, completedAt: completedAt.map { .value($0) } ?? .null, createdAt: 1, updatedAt: 1)
    }

    @Test func everyConnectFetchesTheSnapshotAndBackfillsActivity() async {
        let h = Harness(boardProject: "p1")
        let done = (0..<15).map { Self.tk("d\($0)", status: .done, completedAt: Double(100 - $0)) }
        h.client.s.withLock {
            $0.live = [Self.tk("w1"), Self.tk("w2", status: .review)]
            $0.donePage = TicketPage(tickets: done, nextCursor: "c", total: 40)
        }
        h.store.start()
        #expect(!h.store.state.ready)
        h.socket.connect(true)
        await eventually { h.store.state.ready && h.client.count("activity") == 14 }
        #expect(h.store.state.connected)
        #expect(h.client.calls.all.contains("tickets planning,in_progress,blocked,review"))
        #expect(h.client.calls.all.contains("page done p1 50 -"))
        #expect(h.store.state.donePaging["p1"]?.total == 40)
        #expect(h.store.state.watchers.isEmpty && h.store.state.settings == nil) // optional calls failed, snapshot still applied
        // Every non-done ticket plus the 12 newest done ones.
        await settle()
        let asked = Set(h.client.calls.all.filter { $0.hasPrefix("activity") })
        let expected = (["W1", "W2"] + (0..<12).map { "D\($0)" }).map { "activity \($0)" }
        #expect(asked == Set(expected))
        #expect(h.store.state.latestActivity("s-W1")?.id == "act-W1")
        #expect(h.store.epoch == 0)
        #expect(h.store.loadError == nil)
    }

    @Test func activityBackfillRunsAtMostSixAtATime() async {
        let h = Harness()
        let live = (0..<10).map { Self.tk("t\($0)") }
        let holds = Dictionary(uniqueKeysWithValues: live.map { ($0.key, Deferred<[ActivityEntry]>()) })
        h.client.s.withLock {
            $0.live = live
            $0.activityHold = holds
        }
        h.store.start()
        h.socket.connect(true)
        await eventually { h.client.count("activity") == 6 }
        await settle()
        #expect(h.client.count("activity") == 6)
        for d in holds.values { d.resolve([]) }
        await eventually { h.client.count("activity") == 10 }
        #expect(h.client.inFlightActivity.withLock { $0.max } == 6)
    }

    @Test func refreshReturnsOnceTheSnapshotLandsWithoutWaitingForActivity() async {
        let h = Harness()
        let never = Deferred<[ActivityEntry]>() // never settled
        h.client.s.withLock {
            $0.live = [Self.tk("w1")]
            $0.activityHold = ["W1": never]
        }
        var returned = false
        let refresh = Task { await h.store.refresh(); returned = true }
        await eventually { h.client.count("activity W1") == 1 }
        // A refresh that waited on the backfill would still be pending here.
        let finished = await eventually({ returned }, timeout: .milliseconds(500))
        #expect(finished)
        #expect(h.store.state.ready)
        #expect(!never.isSettled)
        #expect(h.store.state.activity["s-W1"] == nil)
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

    @Test func everyRefreshReadsTheServicesReleaseAndAFailedHealthKeepsTheLastOne() async {
        let h = Harness()
        h.client.s.withLock { $0.health = Health(version: "0.1.0", pid: 1, release: .value("app-20261003.1524")) }
        await h.store.refresh()
        #expect(h.store.releaseMismatch(appBuild: "202610031524") == nil)
        #expect(h.store.releaseMismatch(appBuild: "202609271854") == .appOlder(app: "app-20260927.1854", service: "app-20261003.1524"))
        // A development build (CFBundleVersion "1") belongs to no release.
        #expect(h.store.releaseMismatch(appBuild: "1") == nil)

        h.client.s.withLock { $0.health = nil }
        await h.store.refresh()
        #expect(h.store.health?.release == .value("app-20261003.1524"))

        h.client.s.withLock { $0.health = Health(version: "0.1.0", pid: 1, release: .value("app-20261010.0900")) }
        await h.store.refresh()
        #expect(h.store.releaseMismatch(appBuild: "202610031524") == .appOlder(app: "app-20261003.1524", service: "app-20261010.0900"))
    }

    @Test func aDismissedMismatchStaysHiddenUntilTheServiceMovesToAnotherRelease() async {
        let h = Harness()
        h.client.s.withLock { $0.health = Health(version: "0.1.0", pid: 1, release: .value("app-20260927.1854")) }
        await h.store.refresh()
        let m = try! #require(h.store.releaseMismatch(appBuild: "202610031524"))
        #expect(m == .appNewer(app: "app-20261003.1524", service: "app-20260927.1854"))
        h.store.dismissReleaseMismatch(m)
        #expect(h.store.releaseMismatch(appBuild: "202610031524") == nil)
        await h.store.refresh()
        #expect(h.store.releaseMismatch(appBuild: "202610031524") == nil)

        h.client.s.withLock { $0.health = Health(version: "0.1.0", pid: 1, release: .value("app-20261001.0800")) }
        await h.store.refresh()
        #expect(h.store.releaseMismatch(appBuild: "202610031524") == .appNewer(app: "app-20261003.1524", service: "app-20261001.0800"))
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
        await eventually { h.client.count("activity") == 2 }
    }

    @Test func aFailingDonePageOtherThan404FailsTheSnapshot() async {
        let h = Harness()
        h.client.s.withLock { $0.pageError = HarnessAPIError(status: 500, message: "boom") }
        await h.store.refresh()
        #expect(!h.store.state.ready)
        #expect(h.store.loadError == "boom")
    }

    @Test func planUsageIsFetchedOnRefreshKeptWhenAFetchFailsAndReplacedByLiveEvents() async {
        func report(_ pct: Double) -> PlanUsageReport {
            PlanUsageReport(drivers: [DriverPlanUsage(driver: "claude-code", name: "Claude Code", windows: [
                PlanWindow(id: .fiveHour, label: "5-hour", usedPercent: pct, resetsAt: 1, windowSeconds: 18_000),
            ], fetchedAt: 1)])
        }
        let h = Harness()
        // A service without /usage (or one that fails) leaves no report, and doesn't fail the snapshot.
        await h.store.refresh()
        #expect(h.store.usage == nil)
        #expect(h.store.loadError == nil)

        h.client.s.withLock { $0.usage = report(10) }
        await h.store.refresh()
        #expect(h.store.usage == report(10))

        h.client.s.withLock { $0.usage = nil }
        await h.store.refresh()
        #expect(h.store.usage == report(10))

        h.store.start()
        h.socket.emit(.usageUpdated(usage: report(42)))
        await eventually { h.store.usage == report(42) }
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

    @Test func foregroundingRebuildsTheSocketAndItsFirstConnectBumpsTheEpoch() async {
        let h = Harness()
        h.store.start()
        #expect(h.sockets.count == 1)
        h.store.sceneBecameActive() // never backgrounded: nothing
        #expect(h.sockets.count == 1)
        h.store.sceneDidEnterBackground()
        h.store.sceneBecameActive()
        #expect(h.sockets.count == 2)
        await eventually { h.sockets[0].closed.withLock { $0 } }
        // The rebuilt socket connects: a snapshot, and views refetch (the epoch).
        h.socket.connect(true)
        await eventually { h.store.state.connected && h.client.count("projects") == 1 }
        #expect(h.store.epoch == 1)
        // Still looking connected (a suspended socket nobody noticed drop): rebuilt all the same.
        h.store.sceneDidEnterBackground()
        h.store.sceneBecameActive()
        #expect(h.sockets.count == 3)
        await eventually { h.sockets[1].closed.withLock { $0 } }
        h.socket.connect(true)
        await eventually { h.store.epoch == 2 && h.client.count("projects") == 2 }
        // The grace timer was cleared when it opened: the store stays connected.
        h.clock.advance(by: BoardStore.reopenGraceMs)
        await settle()
        #expect(h.store.state.connected)
    }

    @Test func aRebuiltSocketThatDoesNotOpenInTimeReportsDisconnectedAndStartsPolling() async {
        let h = Harness()
        h.store.start()
        h.socket.connect(true)
        await eventually { h.store.state.connected && h.client.count("projects") == 1 }
        h.store.sceneDidEnterBackground()
        h.store.sceneBecameActive()
        // The old socket's status no longer counts; the banner keeps "connected" during the grace.
        h.clock.advance(by: BoardStore.reopenGraceMs - 1)
        await settle()
        #expect(h.store.state.connected)
        h.clock.advance(by: 1)
        await eventually { !h.store.state.connected }
        // Disconnected: the snapshot poll takes over.
        h.clock.advance(by: BoardStore.disconnectedPollMs)
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

    @Test func aGroupBoardPagesDoneByGroupNotByProject() async {
        let h = Harness(boardProject: Paging.groupScope("Work"))
        await h.store.refresh()
        #expect(h.client.calls.all.contains("page done group=Work 50 -"))
        #expect(h.store.state.donePaging["group:Work"] != nil)
        h.store.setBoardScope(Paging.groupScope("Side projects"))
        await eventually { h.client.calls.all.contains("page done group=Side projects 50 -") }
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
