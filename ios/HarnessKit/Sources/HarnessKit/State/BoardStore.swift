import Foundation
import Observation

// The app's live store: Connection → HarnessClient + HarnessSocket → the reducer. A full snapshot
// on connect and on every reconnect (views refetch what they own when `epoch` bumps), raw event
// fan-out for the Browser tab, and the phone-specific policy: iOS suspends the socket in the
// background, so returning to the foreground rebuilds it and refetches; a 401 (token rotated on
// the Mac) is surfaced for re-pairing.
// Paging: the snapshot is every non-done ticket plus the first Done page for the board's project
// filter; BoardLoader pages Done and runs the board search, DetailFetcher fills in the tickets the
// UI references that aren't loaded (older done dependencies, conductors' done children).
//
// UI-framework-free: the app shell owns one per connection and injects it into SwiftUI.

/// The live event stream BoardStore listens to (HarnessSocket), as a seam for tests.
public protocol EventSource: AnyObject, Sendable {
    /// Every HarnessEvent, until closed.
    var events: AsyncStream<HarnessEvent> { get }
    /// `true` when a connection opens, `false` when it drops.
    var status: AsyncStream<Bool> { get }
    func close() async
}

extension HarnessSocket: EventSource {}

/// The socket's outgoing side the Browser tab uses (HarnessSocket), as a seam for tests. An
/// EventSource that doesn't conform simply drops browser messages.
public protocol BrowserChannel: AnyObject, Sendable {
    /// Sent when a connection is open, otherwise dropped.
    func send(_ msg: ClientMessage) async
    /// Stream a session's browser frames; re-sent on every reconnect of this socket.
    func subscribeBrowser(_ sessionId: String) async
    func unsubscribeBrowser(_ sessionId: String) async
}

extension HarnessSocket: BrowserChannel {}

@MainActor
@Observable
public final class BoardStore {
    /// Remote IDs from the details fetched so far (Related.swift): each ticket's relatedTickets by
    /// ticket id, and the tickets a remote-only key points to by the upper-cased key.
    public struct Related: Equatable, Sendable {
        public var byTicket: [String: [RelatedTicket]] = [:]
        public var byRemoteKey: [String: [RelatedTicket]] = [:]
    }

    /// REST snapshot when the socket hasn't connected this long after start (ms).
    public static let restFallbackMs: Double = 1500
    /// Snapshot poll while disconnected, so a 401 (rotated token) is noticed (ms).
    public static let disconnectedPollMs: Double = 8000
    /// Summaries backfilled after a snapshot: every non-done ticket plus this many newest done.
    public static let summaryBackfillDone = 12
    public static let summaryConcurrency = 6

    public private(set) var state = BoardState.initial
    /// Bumped on every reconnect so views can refetch what they own.
    public private(set) var epoch = 0
    /// Set when the service rejects the token; the UI offers re-pairing.
    public private(set) var authError: String?
    /// Last snapshot failure (host unreachable etc.), cleared by the next success.
    public private(set) var loadError: String?
    public private(set) var related = Related()
    /// Bumped whenever the socket is rebuilt (foregrounding). A rebuilt socket has no browser
    /// subscriptions and its first connect doesn't bump `epoch`, so the Browser tab resubscribes on
    /// either.
    public private(set) var socketGeneration = 0

    public let baseUrl: String
    @ObservationIgnored public let client: any BoardClient
    /// Done paging + board search requests (state lives in state.donePaging / state.search)
    @ObservationIgnored public private(set) var loader: BoardLoader!
    @ObservationIgnored private var details: DetailFetcher!
    @ObservationIgnored private let makeSocket: @MainActor () -> any EventSource
    @ObservationIgnored private let timers: any Timers
    @ObservationIgnored private var socket: (any EventSource)?
    @ObservationIgnored private var socketTasks: [Task<Void, Never>] = []
    /// Browser messages for the current socket, sent one at a time so input keeps its order.
    @ObservationIgnored private var outbox: AsyncStream<BrowserOp>.Continuation?
    @ObservationIgnored private var fallbackTimer: TimerHandle?
    @ObservationIgnored private var pollTimer: TimerHandle?
    @ObservationIgnored private var scope: String
    @ObservationIgnored private var watched: [String: Int] = [:]
    @ObservationIgnored private var listeners: [Int: @MainActor (HarnessEvent) -> Void] = [:]
    @ObservationIgnored private var nextListener = 0
    @ObservationIgnored private var backgrounded = false
    @ObservationIgnored private var closed = false

    /// - Parameters:
    ///   - boardProject: the board's project filter at launch (prefs.boardProject)
    ///   - makeSocket: opens the live event stream (rebuilt on foregrounding)
    public init(
        client: any BoardClient,
        baseUrl: String,
        boardProject: String? = nil,
        makeSocket: @escaping @MainActor () -> any EventSource,
        timers: any Timers = TaskTimers()
    ) {
        self.client = client
        self.baseUrl = baseUrl
        self.makeSocket = makeSocket
        self.timers = timers
        self.scope = Paging.scopeOf(boardProject)
        self.loader = BoardLoader(
            client: client,
            dispatch: { [unowned self] in self.dispatch($0) },
            getState: { [unowned self] in self.state },
            describe: { [baseUrl] in Connection.describeError($0, baseUrl: baseUrl) },
            timers: timers)
        self.details = DetailFetcher(
            client: client,
            dispatch: { [unowned self] in self.dispatch($0) },
            onRelated: { [unowned self] id, list in self.related.byTicket[id] = list },
            onRemoteKey: { [unowned self] key, list in
                if list.isEmpty && self.related.byRemoteKey[key] == nil { return }
                self.related.byRemoteKey[key] = list
            })
    }

    /// A store for a paired service: the real client and socket.
    public convenience init(client: HarnessClient, boardProject: String? = nil, timers: any Timers = TaskTimers()) {
        self.init(client: client, baseUrl: client.baseUrl, boardProject: boardProject, makeSocket: { client.connect() }, timers: timers)
    }

    // MARK: Lifecycle

    /// Open the socket and start the connection policy. Call once.
    public func start() {
        guard socket == nil, !closed else { return }
        openSocket()
        // REST can work while the socket can't (or before it connects): show what we can.
        fallbackTimer = timers.set(Self.restFallbackMs) { [weak self] in
            guard let self else { return }
            self.fallbackTimer = nil
            if !self.state.ready { Task { await self.refresh() } }
        }
        updatePolling()
    }

    /// Stop everything: the socket closes and nothing in flight lands.
    public func close() {
        closed = true
        loader.dispose()
        closeSocket()
        if let fallbackTimer { timers.clear(fallbackTimer) }
        if let pollTimer { timers.clear(pollTimer) }
        fallbackTimer = nil
        pollTimer = nil
    }

    /// The app went to the background (scenePhase .background).
    public func sceneDidEnterBackground() {
        backgrounded = true
    }

    /// Back from the background: the OS dropped the socket (or it's mid-backoff). Rebuild it when
    /// disconnected, else refetch.
    public func sceneBecameActive() {
        guard backgrounded, !closed else { return }
        backgrounded = false
        if !state.connected {
            closeSocket()
            openSocket()
        } else {
            Task { await refresh() }
        }
    }

    private func openSocket() {
        let socket = makeSocket()
        self.socket = socket
        socketGeneration += 1
        // A rebuilt socket starts over (`first` lives with the socket): its first connect doesn't
        // bump the epoch.
        var first = true
        let (ops, opsIn) = AsyncStream<BrowserOp>.makeStream()
        outbox = opsIn
        let channel = socket as? any BrowserChannel
        socketTasks = [
            Task {
                for await op in ops {
                    guard let channel else { continue }
                    switch op {
                    case let .send(msg): await channel.send(msg)
                    case let .subscribe(id): await channel.subscribeBrowser(id)
                    case let .unsubscribe(id): await channel.unsubscribeBrowser(id)
                    }
                }
            },
            Task { @MainActor [weak self] in
                for await event in socket.events {
                    guard let self, !Task.isCancelled else { return }
                    self.receive(event)
                }
            },
            Task { @MainActor [weak self] in
                for await connected in socket.status {
                    guard let self, !Task.isCancelled else { return }
                    self.dispatch(.connected(connected))
                    if connected {
                        Task { await self.refresh() }
                        if !first { self.epoch += 1 }
                        first = false
                    }
                }
            },
        ]
    }

    private func closeSocket() {
        outbox?.finish()
        outbox = nil
        for t in socketTasks { t.cancel() }
        socketTasks = []
        if let socket {
            Task { await socket.close() }
        }
        socket = nil
    }

    /// While disconnected, poll the snapshot slowly so a 401 (rotated token) is noticed: the
    /// socket just keeps reconnecting and never says why.
    private func updatePolling() {
        if state.connected || closed {
            if let pollTimer { timers.clear(pollTimer) }
            pollTimer = nil
            return
        }
        guard pollTimer == nil else { return }
        pollTimer = timers.set(Self.disconnectedPollMs) { [weak self] in
            guard let self else { return }
            self.pollTimer = nil
            guard !self.state.connected, !self.closed else { return }
            Task { await self.refresh() }
            self.updatePolling()
        }
    }

    // MARK: State

    /// Apply an action (views dispatch optimistic updates and backfills through here too).
    public func dispatch(_ action: BoardAction) {
        let wasConnected = state.connected
        state.reduce(action)
        if state.connected != wasConnected { updatePolling() }
        if Self.affectsKeys(action) { syncDetails() }
    }

    private func receive(_ event: HarnessEvent) {
        switch event {
        case .browserFrame, .browserState: break
        default: dispatch(.event(event))
        }
        for fn in listeners.values { fn(event) }
    }

    /// Every raw event (browser frames included), for views that consume them directly. Call the
    /// returned closure to stop listening.
    @discardableResult
    public func onEvent(_ fn: @escaping @MainActor (HarnessEvent) -> Void) -> @MainActor () -> Void {
        nextListener += 1
        let id = nextListener
        listeners[id] = fn
        return { [weak self] in self?.listeners[id] = nil }
    }

    // MARK: Browser

    enum BrowserOp: Sendable {
        case send(ClientMessage)
        case subscribe(String)
        case unsubscribe(String)
    }

    /// Stream a session's browser frames and state (browser.frame / browser.state reach `onEvent`
    /// listeners) on the current socket. Resubscribe when `epoch` or `socketGeneration` changes.
    public func subscribeBrowser(_ sessionId: String) {
        outbox?.yield(.subscribe(sessionId))
    }

    public func unsubscribeBrowser(_ sessionId: String) {
        outbox?.yield(.unsubscribe(sessionId))
    }

    /// Mouse, key, text, navigation and resize input for a session's browser, sent in call order.
    /// Dropped while the socket is down.
    public func sendBrowserInput(_ sessionId: String, _ input: BrowserInput) {
        outbox?.yield(.send(.browserInput(sessionId: sessionId, input: input)))
    }

    /// Whether an action can change what DetailFetcher wants (it re-syncs on ready, tickets,
    /// dependents, sessions, keyAliases, missingKeys, childrenLoaded).
    static func affectsKeys(_ action: BoardAction) -> Bool {
        switch action {
        case let .event(e):
            switch e {
            case .ticketUpserted, .ticketDeleted, .projectDeleted, .sessionUpserted: return true
            default: return false
            }
        case .snapshot, .detail, .tickets, .missingKeys, .donePage, .searchResults: return true
        default: return false
        }
    }

    private func syncDetails() {
        details.sync(state, extra: watched.keys.sorted())
    }

    // MARK: Snapshot

    /// The full snapshot for the current scope. Returns once it's applied; the summaries backfill
    /// it starts runs on its own.
    public func refresh() async {
        do {
            let snapshot = try await loadSnapshot(scope)
            guard !closed else { return }
            dispatch(.snapshot(snapshot))
            loader.legacy = snapshot.donePage == nil
            loader.snapshotApplied()
            details.reset()
            syncDetails()
            authError = nil
            loadError = nil
            // Not awaited: pull to refresh ends once the snapshot lands.
            Task { await self.backfillSummaries(snapshot) }
        } catch {
            guard !closed else { return }
            if Connection.isUnauthorized(error) {
                authError = Connection.describeError(error)
            } else {
                loadError = Connection.describeError(error, baseUrl: baseUrl)
            }
        }
    }

    private func loadSnapshot(_ scope: String) async throws -> BoardSnapshot {
        let client = client
        async let projects = client.listProjects()
        async let tickets = client.listTickets(projectId: nil, status: Paging.liveStatuses)
        // A service from before paging answers 404 here (and ignores ?status=, sending every ticket).
        async let donePage: TicketPage? = {
            do {
                return try await client.ticketPage(status: .done, projectId: Paging.scopeProject(scope), q: nil, limit: Paging.donePageSize, cursor: nil)
            } catch let e as HarnessAPIError where e.status == 404 {
                return nil
            }
        }()
        async let sessions = client.listSessions(kind: nil)
        async let watchers = (try? await client.listWatchers()) ?? []
        async let settings = try? await client.getSettings()
        async let drivers = (try? await client.listDrivers()) ?? []
        let page = try await donePage
        return BoardSnapshot(
            projects: try await projects, tickets: try await tickets, sessions: try await sessions,
            watchers: await watchers, settings: await settings, drivers: await drivers,
            donePage: page.map { .init(scope: scope, page: $0) })
    }

    private func backfillSummaries(_ snapshot: BoardSnapshot) async {
        let done = snapshot.donePage?.page.tickets
            ?? snapshot.tickets.filter { $0.status == .done }.sorted { Paging.completedAtOf($0) > Paging.completedAtOf($1) }
        let wanted = snapshot.tickets.filter { $0.status != .done } + done.prefix(Self.summaryBackfillDone)
        let client = client
        var queue = wanted[...]
        await withTaskGroup(of: (String, [Summary]?).self) { group in
            func next() -> Bool {
                guard let t = queue.popFirst() else { return false }
                group.addTask { (t.sessionId, try? await client.listSummaries(t.key)) }
                return true
            }
            for _ in 0..<Self.summaryConcurrency { if !next() { break } }
            while let (sessionId, summaries) = await group.next() {
                if let summaries, !closed { dispatch(.summaries(sessionId: sessionId, summaries: summaries)) }
                _ = next()
            }
        }
    }

    // MARK: Board

    /// The board's project filter changed: snapshots page Done for it; fetches its first page.
    public func setBoardScope(_ projectId: String?) {
        scope = Paging.scopeOf(projectId)
        loader.ensureFirstPage(projectId)
    }

    /// A ticket's detail merged into the store (shared with the background fetches for that key).
    public func loadDetail(_ key: String) async throws -> TicketDetail {
        try await details.load(key)
    }

    /// Keep this key resolved while a screen shows it (a ticket that may not be loaded). Call the
    /// returned closure when the screen goes away.
    public func watchKey(_ key: String) -> @MainActor () -> Void {
        watched[key, default: 0] += 1
        syncDetails()
        var released = false
        return { [weak self] in
            guard let self, !released else { return }
            released = true
            if (self.watched[key] ?? 0) <= 1 { self.watched[key] = nil } else { self.watched[key]! -= 1 }
            self.syncDetails()
        }
    }
}
