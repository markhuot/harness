import Foundation
import Testing
@testable import HarnessKit

@Suite("Widgets: the active-ticket feed, the shared files and the load")
struct WidgetFeedTests {
    static func ticket(
        _ n: Int, _ status: TicketStatus, updatedAt: Double = 1, busy: Bool = false, draft: Bool? = nil, parent: String? = nil,
        project: String = "p1", title: String = "T", blocked: String? = nil, approval: String? = nil, remote: String? = nil
    ) -> Ticket {
        var t = Ticket(
            id: "t\(n)", key: "H-\(n)", projectId: project, title: title, spec: "", status: status, sessionId: "s\(n)", driver: "dummy",
            position: 0, createdAt: 1, updatedAt: updatedAt
        )
        t.busy = busy
        t.draft = draft
        t.parentId = parent
        t.blockedReason = blocked
        t.pendingApproval = approval.map { PendingApproval(id: "a", runId: "r", toolName: $0, input: .null, requestedAt: 1) }
        t.externalRef = remote.map { ExternalRef(source: "jira", key: $0) }
        return t
    }

    static let project = Project(id: "p1", key: "HARNESS", name: "Harness", path: "/x", nextSeq: 1, useWorktrees: true, color: "teal", createdAt: 1, updatedAt: 1)

    static func entry(_ body: String, kind: ActivityKind = .note) -> ActivityEntry {
        ActivityEntry(id: UUID().uuidString, sessionId: "s", kind: kind, author: .agent, body: body, createdAt: 1)
    }

    // MARK: isActive / order

    @Test func activeMeansWorkedOnOrBusy() {
        #expect(WidgetFeed.isActive(Self.ticket(1, .inProgress)))
        #expect(WidgetFeed.isActive(Self.ticket(1, .blocked)))
        #expect(WidgetFeed.isActive(Self.ticket(1, .review)))
        // A planning ticket counts only while an agent drafts its plan.
        #expect(!WidgetFeed.isActive(Self.ticket(1, .planning)))
        #expect(WidgetFeed.isActive(Self.ticket(1, .planning, busy: true)))
        #expect(!WidgetFeed.isActive(Self.ticket(1, .done, busy: true)))
        #expect(!WidgetFeed.isActive(Self.ticket(1, .unknown("archived"), busy: true)))
        // A draft never runs, whatever its column.
        #expect(!WidgetFeed.isActive(Self.ticket(1, .inProgress, draft: true)))
    }

    @Test func mostRecentlyUpdatedFirstWithStableTies() {
        let list = WidgetFeed.active([
            Self.ticket(1, .review, updatedAt: 5),
            Self.ticket(2, .done, updatedAt: 99),
            Self.ticket(10, .inProgress, updatedAt: 7),
            Self.ticket(3, .blocked, updatedAt: 7),
        ])
        // H-10 before H-3 on the tie: keys compare as strings, the way the TS board sorts them.
        #expect(list.map(\.key) == ["H-10", "H-3", "H-1"])
    }

    // MARK: snapshot

    @Test func snapshotKeepsTheLimitAndCountsEveryActiveTicket() {
        let tickets = (1...14).map { Self.ticket($0, .inProgress, updatedAt: Double($0)) }
        let s = WidgetFeed.snapshot(tickets: tickets, projects: ["p1": Self.project], now: 42, limit: 10)
        #expect(s.tickets.count == 10)
        #expect(s.tickets.first?.key == "H-14")
        #expect(s.activeCount == 14)
        #expect(s.generatedAt == 42)
    }

    @Test func snapshotResolvesProjectKeysAndRemoteIds() {
        let s = WidgetFeed.snapshot(
            tickets: [Self.ticket(1, .inProgress, remote: "MH-62"), Self.ticket(2, .inProgress, project: "gone")],
            projects: ["p1": Self.project], now: 1
        )
        let linked = s.tickets.first { $0.key == "H-1" }
        #expect(linked?.displayKey == "MH-62")
        #expect(linked?.projectKey == "HARNESS")
        #expect(linked?.projectColor == "teal")
        let orphan = s.tickets.first { $0.key == "H-2" }
        #expect(orphan?.displayKey == "H-2")
        #expect(orphan?.projectKey == nil)
    }

    @Test func aConductorIsWorkingWhileAChildRuns() {
        let s = WidgetFeed.snapshot(
            tickets: [Self.ticket(1, .inProgress, updatedAt: 2), Self.ticket(2, .inProgress, updatedAt: 1, busy: true, parent: "t1")],
            projects: [:], now: 1
        )
        #expect(s.tickets.map(\.working) == [true, true])
        let idle = WidgetFeed.snapshot(tickets: [Self.ticket(1, .inProgress)], projects: [:], now: 1)
        #expect(idle.tickets.first?.working == false)
    }

    @Test func anApprovalWinsOverTheBlockedReason() {
        let s = WidgetFeed.snapshot(
            tickets: [
                Self.ticket(1, .blocked, updatedAt: 3, blocked: "Which API?"),
                Self.ticket(2, .blocked, updatedAt: 2, blocked: "Needs approval", approval: "mcp__harness__create_project"),
                Self.ticket(3, .inProgress, updatedAt: 1, blocked: "stale reason"),
                Self.ticket(4, .blocked, updatedAt: 0, blocked: ""),
            ],
            projects: [:], now: 1
        )
        #expect(s.tickets[0].blockedReason == "Which API?")
        #expect(s.tickets[0].approvalTool == nil)
        #expect(s.tickets[1].blockedReason == nil)
        #expect(s.tickets[1].approvalTool == "create_project")
        // Only a blocked ticket shows its reason, and an empty one is no reason.
        #expect(s.tickets[2].blockedReason == nil)
        #expect(s.tickets[3].blockedReason == nil)
    }

    @Test func newsIsPlainTextAndAnEmptyLineIsNone() {
        let s = WidgetFeed.snapshot(
            tickets: [Self.ticket(1, .inProgress, updatedAt: 2), Self.ticket(2, .inProgress, updatedAt: 1)],
            projects: [:], news: { $0.key == "H-1" ? Self.entry("Fixed **the** `retry`") : Self.entry("") }, now: 1
        )
        #expect(s.tickets[0].news == "Fixed the retry")
        #expect(s.tickets[1].news == nil)
    }

    @Test func sameContentIgnoresWhenItWasTaken() {
        let a = WidgetFeed.snapshot(tickets: [Self.ticket(1, .inProgress)], projects: [:], now: 1)
        let b = WidgetFeed.snapshot(tickets: [Self.ticket(1, .inProgress)], projects: [:], now: 2)
        let c = WidgetFeed.snapshot(tickets: [Self.ticket(1, .review)], projects: [:], now: 1)
        #expect(a.sameContent(as: b))
        #expect(!a.sameContent(as: c))
    }

    @Test func ticketLinksEncodeTheKey() {
        #expect(WidgetFeed.ticketURL("H-1")?.absoluteString == "harness://ticket/H-1")
        #expect(WidgetFeed.ticketURL("A B/1")?.absoluteString == "harness://ticket/A%20B%2F1")
        #expect(DeepLink.parse(WidgetFeed.ticketURL("H-1")!) == .push(.ticket(key: "H-1", tab: nil)))
        #expect(DeepLink.parse(WidgetFeed.boardURL) == .tab(.board))
    }

    // MARK: fetch

    static func json(_ value: some Encodable) -> HTTPResponse {
        let data = try! JSONEncoder().encode(value)
        return HTTPResponse(status: 200, body: Data(#"{"data":"#.utf8) + data + Data("}".utf8))
    }

    @Test func fetchAsksForActiveStatusesAndNewsOfTheFirstFew() async throws {
        let tickets = (1...5).map { Self.ticket($0, .inProgress, updatedAt: Double($0)) }
        let transport = FakeTransport { req in
            let path = req.url.path()
            if path == "/tickets" { return Self.json(tickets) }
            if path == "/projects" { return Self.json([Self.project]) }
            if path == "/tickets/H-5/activity" { return Self.json([Self.entry("newest"), Self.entry("x", kind: .moved)]) }
            if path == "/tickets/H-4/activity" { return HTTPResponse(status: 500, body: Data(#"{"error":"boom"}"#.utf8)) }
            if path.hasSuffix("/activity") { return Self.json([Self.entry("older")]) }
            return HTTPResponse(status: 404, body: Data(#"{"error":"no"}"#.utf8))
        }
        let s = try await WidgetFeed.fetch(HarnessClient(baseUrl: "http://mac:7717", token: "tok", transport: transport), now: 9)
        let list = transport.requests.first { $0.url.path() == "/tickets" }
        #expect(list?.url.query()?.removingPercentEncoding == "status=planning,in_progress,blocked,review")
        let activity = Set(transport.requests.map { $0.url.path() }.filter { $0.hasSuffix("/activity") })
        #expect(activity == ["/tickets/H-5/activity", "/tickets/H-4/activity", "/tickets/H-3/activity"])
        // The latest news kind wins over a later move; a failed Activity fetch only drops its line.
        #expect(s.tickets.map { $0.news } == ["newest", nil, "older", nil, nil])
        #expect(s.tickets.first?.projectKey == "HARNESS")
    }

    @Test func fetchFailsWhenTheTicketsCantBeRead() async {
        let client = HarnessClient(baseUrl: "http://mac:7717", token: "bad", transport: FakeTransport(status: 401, body: #"{"error":"unauthorized"}"#))
        await #expect(throws: HarnessAPIError.self) { try await WidgetFeed.fetch(client, now: 1) }
    }

    // MARK: shared files + load

    static func tempShared() -> WidgetShared {
        WidgetShared(directory: FileManager.default.temporaryDirectory.appending(path: "widget-\(UUID().uuidString)"))
    }

    @Test func sharedFilesRoundTripAndNilRemoves() throws {
        let shared = Self.tempShared()
        #expect(shared.readHost() == nil)
        let host = WidgetHost(baseUrl: "http://mac:7717", token: "tok", name: "Mac", lightTheme: "pierre-light")
        try shared.writeHost(host)
        #expect(shared.readHost() == host)
        try shared.writeHost(nil)
        #expect(shared.readHost() == nil)
        try shared.writeHost(nil) // removing a missing file is fine
        try Data("not json".utf8).write(to: shared.directory.appending(path: WidgetShared.snapshotFile))
        #expect(shared.readSnapshot() == nil)
    }

    @Test func loadWithoutAHostIsUnpaired() async {
        let shared = Self.tempShared()
        let load = await WidgetLoad.load(shared, now: 1) { _, _ in Issue.record("no fetch without a host"); return .empty }
        #expect(load.source == .unpaired)
        #expect(load.snapshot == .empty)
        let none = await WidgetLoad.load(nil, now: 1) { _, _ in .empty }
        #expect(none.source == .unpaired)
    }

    @Test func aLiveLoadSavesItsSnapshotAndAFailedOneFallsBackToIt() async throws {
        let shared = Self.tempShared()
        try shared.writeHost(WidgetHost(baseUrl: "http://mac:7717", token: "tok"))
        let live = WidgetFeed.snapshot(tickets: [Self.ticket(1, .inProgress)], projects: [:], now: 5)
        let first = await WidgetLoad.load(shared, now: 5) { host, now in
            #expect(host.token == "tok")
            #expect(now == 5)
            return live
        }
        #expect(first.source == .live)
        #expect(shared.readSnapshot() == live)

        struct Offline: LocalizedError { var errorDescription: String? { "offline" } }
        let second = await WidgetLoad.load(shared, now: 6) { _, _ in throw Offline() }
        #expect(second.source == .saved("offline"))
        #expect(second.snapshot == live)
    }
}
