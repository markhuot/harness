import HarnessKit
import SwiftUI
@testable import Harness

/// Fixed fixture models and a store fed from them, so a screen renders without a daemon, a pairing
/// or the network. Every date derives from `now`, which is also what the screens treat as the
/// current time (`\.snapshotNow`), so "5m ago" never changes between runs.
@MainActor
struct SnapshotWorld {
    /// 2027-01-15 09:00 UTC, in ms.
    static let now: Double = 1_800_003_600_000
    static func ago(minutes: Double) -> Double { now - minutes * 60_000 }

    let app: AppModel
    let store: BoardStore
    let actions = Actions()

    static let project = Project(
        id: "p-harness", key: "HAR", name: "Harness", path: "/Users/dev/harness", nextSeq: 12, useWorktrees: true,
        isGit: true, color: "#6d5cff", createdAt: ago(minutes: 90_000), updatedAt: ago(minutes: 90_000))

    static let spec = """
        ## Goal
        Let people **pause** a running ticket from the board, and pick it up again later.

        ## Plan
        1. Add a `Pause` action to the ticket menu.
        2. Keep the session, so `Resume` continues where it stopped.
        3. Show a paused ticket in *Blocked* with the reason.

        ## Status
        - [x] Menu item and confirmation
        - [ ] Resume from a push notification
        - [ ] Tests for the paused state

        ```ts
        export function pause(ticket: Ticket) {
          return { ...ticket, status: "blocked", blockedReason: "Paused" };
        }
        ```
        """

    static func ticket(
        _ n: Int, _ title: String, _ status: TicketStatus, busy: Bool = false, blocked: String? = nil, minutes: Double = 30,
        agentReview: ReviewState = .pending, dependsOn: [String] = []
    ) -> Ticket {
        Ticket(
            id: "t-\(n)", key: "HAR-\(n)", projectId: project.id, title: title, spec: n == 7 ? spec : "A short spec for \(title).",
            specRevision: 3, status: status, sessionId: "s-\(n)", driver: "claude-code", dependsOn: dependsOn,
            agentReview: agentReview, branch: status == .planning ? nil : "harness/har-\(n)",
            blockedReason: blocked, busy: busy, position: Double(n), completedAt: status == .done ? .value(ago(minutes: minutes)) : .absent,
            createdAt: ago(minutes: minutes + 600), updatedAt: ago(minutes: minutes))
    }

    static let tickets: [Ticket] = [
        ticket(1, "Draft the pause and resume plan", .planning, minutes: 8),
        ticket(2, "Add a settings screen for notification sounds", .planning, minutes: 70),
        ticket(3, "Speed up the board's first paint", .inProgress, minutes: 3),
        ticket(4, "Fix the widget refresh after pairing", .inProgress, minutes: 25),
        ticket(5, "Which export format should the report use?", .blocked, blocked: "Waiting on an answer", minutes: 14),
        ticket(7, "Pause a running ticket from the board", .review, minutes: 42, agentReview: .approved, dependsOn: ["HAR-3"]),
        ticket(8, "Retry failed uploads on a flaky network", .review, minutes: 260),
        ticket(9, "Tidy the changelog headings", .done, minutes: 1_500),
        ticket(10, "Rename Projects to Boards in the sidebar", .done, minutes: 3_000),
    ]

    static func sessions() -> [Session] {
        tickets.map {
            Session(id: $0.sessionId, key: $0.key, kind: .ticket, ticketId: $0.id, driver: "claude-code", cwd: project.path,
                    busy: $0.busy, createdAt: $0.createdAt, updatedAt: $0.updatedAt)
        }
    }

    static func entry(_ n: Int, _ kind: ActivityKind, _ author: ActivityAuthor, _ body: String, minutes: Double, meta: ActivityMeta = .init()) -> ActivityEntry {
        ActivityEntry(id: "a-\(n)", sessionId: "s-7", ticketId: "t-7", kind: kind, author: author, body: body, meta: meta, createdAt: ago(minutes: minutes))
    }

    static let activity: [ActivityEntry] = [
        entry(1, .specRevised, .agent, "Plan drafted: pause keeps the session so resume continues", minutes: 300, meta: ActivityMeta(specRevision: 1)),
        entry(2, .moved, .human, "Work started", minutes: 280, meta: ActivityMeta(from: .planning, to: .inProgress)),
        entry(3, .note, .agent, "Added the Pause menu item; the confirmation dialog still needs copy.", minutes: 190),
        entry(4, .blocked, .agent, "Should a paused ticket keep its worktree?", minutes: 150,
              meta: ActivityMeta(question: "Should a paused ticket keep its worktree?", from: .inProgress, to: .blocked)),
        entry(5, .answer, .human, "Yes, keep it. Clean up when the ticket is done.", minutes: 120),
        entry(6, .unblocked, .system, "Unblocked", minutes: 119, meta: ActivityMeta(from: .blocked, to: .inProgress)),
        entry(7, .submitted, .agent, "Pause and resume work; 14 tests added and passing.", minutes: 50, meta: ActivityMeta(from: .inProgress, to: .review)),
        entry(8, .reviewApproved, .agent, "Reviewer approved: the paused state is covered and the copy reads well.", minutes: 42, meta: ActivityMeta(round: 1)),
    ]

    static let specRevisions: [SpecRevisionInfo] = [
        SpecRevisionInfo(rev: 1, author: .agent, note: "Plan drafted", approvedBaseline: true, createdAt: ago(minutes: 300)),
        SpecRevisionInfo(rev: 2, author: .agent, note: "Status: menu item done", createdAt: ago(minutes: 190)),
        SpecRevisionInfo(rev: 3, author: .agent, note: "Status: tests added", createdAt: ago(minutes: 50)),
    ]

    init() async {
        let client = StubClient()
        let store = BoardStore(client: client, baseUrl: "http://127.0.0.1:1", makeSocket: { StubSocket() })
        let app = AppModel(storage: MemoryStorage(), probe: { _ in .ok(version: "") }, makeStore: { _, _ in store })
        app.load()
        await app.pair(ServerAddress(baseUrl: "http://127.0.0.1:1", token: "snapshot"), skipProbe: true)
        // pair starts the store, which asks the stub; whatever it did, the fixture is the state.
        store.dispatch(.snapshot(BoardSnapshot(projects: [Self.project], tickets: Self.tickets, sessions: Self.sessions())))
        store.dispatch(.connected(true))
        store.dispatch(.activity(sessionId: "s-7", activity: Self.activity))
        store.dispatch(.specRevisions(ticketId: "t-7", revisions: Self.specRevisions))
        if let last = Self.specRevisions.last { store.dispatch(.specRevision(ticketId: "t-7", revision: SpecRevision(last, body: Self.spec))) }
        self.app = app
        self.store = store
    }

    /// The environment every screen gets in the app (HarnessApp, SceneChrome), with a fixed clock.
    func environment<V: View>(_ view: V, router: Router, scheme: ColorScheme) -> some View {
        view
            .environment(app)
            .environment(store)
            .environment(router)
            .environment(actions)
            .environment(\.palette, Palette(app.resolvedTheme(systemDark: scheme == .dark)))
            .environment(\.snapshotNow, Self.now)
    }
}

/// A client that answers nothing: the store is fed directly, so a request that goes out simply fails.
private struct StubClient: BoardClient {
    func ticketPage(status: TicketStatus, projectId: String?, group: String?, q: String?, limit: Int?, cursor: String?) async throws -> TicketPage { throw URLError(.cannotConnectToHost) }
    func searchTickets(q: String, projectId: String?, group: String?, limit: Int?, cursor: String?) async throws -> TicketPage { throw URLError(.cannotConnectToHost) }
    func getTicket(_ key: String) async throws -> TicketDetail { throw URLError(.cannotConnectToHost) }
    func health() async throws -> Health { throw URLError(.cannotConnectToHost) }
    func listProjects() async throws -> [Project] { throw URLError(.cannotConnectToHost) }
    func listTickets(projectId: String?, status: [TicketStatus]) async throws -> [Ticket] { throw URLError(.cannotConnectToHost) }
    func listSessions(kind: SessionKind?) async throws -> [Session] { throw URLError(.cannotConnectToHost) }
    func listWatchers() async throws -> [Watcher] { throw URLError(.cannotConnectToHost) }
    func getSettings() async throws -> PublicSettings { throw URLError(.cannotConnectToHost) }
    func listDrivers() async throws -> [DriverInfo] { throw URLError(.cannotConnectToHost) }
    func listActivity(_ key: String) async throws -> [ActivityEntry] { throw URLError(.cannotConnectToHost) }
}

/// A socket that never connects and never speaks.
private final class StubSocket: EventSource {
    let events = AsyncStream<HarnessEvent> { _ in }
    let status = AsyncStream<Bool> { _ in }
    func close() async {}
}
