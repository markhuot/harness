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
    /// What the store's client answers: nothing unless a test serves a path (`serve`).
    let transport: FixtureTransport

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
        - [x] **[TicketMenu.swift:42](harness://file/ios/Harness/TicketMenu.swift#L42)** menu item and confirmation
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
        // A real client over a transport that answers from fixtures, so `store.api` is set and the
        // screens that fetch through it (usage, attachments, transcripts) get their data.
        let transport = FixtureTransport()
        let client = HarnessClient(baseUrl: "http://127.0.0.1:1", token: "snapshot", transport: transport)
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
        store.setTerminals(Self.terminals)
        self.app = app
        self.store = store
        self.transport = transport
    }

    /// The service's terminals: one made on the Mac running a program, one at a prompt.
    static let terminals: [TerminalInfo] = [
        TerminalInfo(id: "t-dev", cwd: "/Users/mark/Sites/harness", title: "npm run dev", process: "node", projectId: "p-1", createdAt: 2, cols: 62, rows: 24),
        TerminalInfo(id: "t-home", cwd: "/Users/mark", process: "zsh", createdAt: 1),
    ]

    /// Answers `GET path` (the query is ignored) with `{ "data": value }`.
    func serve<T: Encodable>(_ path: String, _ value: T) {
        transport.serve(path, value)
    }

    /// Adds tickets (with their sessions) to the board's fixture, and their transcripts and spec
    /// revisions where given. Dispatches the whole snapshot again, so call it before the test's own dispatches.
    func add(_ extra: [Ticket]) {
        let sessions = Self.sessions() + extra.map {
            Session(id: $0.sessionId, key: $0.key, kind: .ticket, ticketId: $0.id, driver: $0.driver, cwd: Self.project.path,
                    busy: $0.busy, createdAt: $0.createdAt, updatedAt: $0.updatedAt)
        }
        store.dispatch(.snapshot(BoardSnapshot(projects: [Self.project], tickets: Self.tickets + extra, sessions: sessions)))
        store.dispatch(.connected(true))
        store.dispatch(.activity(sessionId: "s-7", activity: Self.activity))
        store.dispatch(.specRevisions(ticketId: "t-7", revisions: Self.specRevisions))
    }

    /// Shows `spec` as the ticket's current revision, the way the Spec tab reads it.
    func setSpec(_ ticket: Ticket, _ spec: String) {
        let info = SpecRevisionInfo(rev: 1, author: .agent, note: "Plan drafted", approvedBaseline: true, createdAt: Self.ago(minutes: 300))
        store.dispatch(.specRevisions(ticketId: ticket.id, revisions: [info]))
        store.dispatch(.specRevision(ticketId: ticket.id, revision: SpecRevision(info, body: spec)))
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

/// A transport that answers the paths a test serves and fails every other request the way an
/// unreachable service does, so the store is fed by dispatch and a stray request just fails.
private struct Envelope<D: Encodable>: Encodable { let data: D }

final class FixtureTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var routes: [String: Data] = [:]

    func serve<T: Encodable>(_ path: String, _ value: T) {
        let body = try! JSONEncoder().encode(Envelope(data: value))
        lock.withLock { routes[path] = body }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let path = request.url.path
        guard request.method == "GET", let body = lock.withLock({ routes[path] }) else { throw URLError(.cannotConnectToHost) }
        return HTTPResponse(status: 200, body: body)
    }
}

/// A socket that never connects and never speaks.
private final class StubSocket: EventSource {
    let events = AsyncStream<HarnessEvent> { _ in }
    let status = AsyncStream<Bool> { _ in }
    func close() async {}
}
