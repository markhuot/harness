import Foundation
import Observation

// The app's live store: Connection → HarnessClient + HarnessSocket → the reducer. A full snapshot
// on connect and on every reconnect (views refetch what they own when `epoch` bumps), raw event
// fan-out for the Browser tab, and the phone-specific policy: iOS suspends the socket in the
// background, so returning to the foreground rebuilds it and refetches; a 401 (token rotated on
// the Mac) is surfaced for re-pairing.
// Paging: the snapshot is every non-done ticket plus the first Done page for the board's filter
// (a project, a project group, or All projects); BoardLoader pages Done and runs the board search, DetailFetcher fills in the tickets the
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
    /// Stream a session's browser frames (on tab `tabId`; nil: the lowest open one; again with
    /// another tab switches); re-sent on every reconnect of this socket. `viewerId` names one view,
    /// so several views can watch different tabs of one session.
    func subscribeBrowser(_ sessionId: String, tabId: Int?, viewerId: String?) async
    func unsubscribeBrowser(_ sessionId: String, viewerId: String?) async
}

extension HarnessSocket: BrowserChannel {}

/// The socket's terminal side (HarnessSocket), as a seam for tests. An EventSource that doesn't
/// conform drops terminal messages and attaches.
public protocol TerminalChannel: AnyObject, Sendable {
    var terminalMessages: AsyncStream<ServerMessage> { get }
    func attachTerminal(_ id: String, deviceId: String, cols: Int, rows: Int) async
    func detachTerminal(_ id: String) async
    func resizeTerminal(_ id: String, cols: Int, rows: Int) async
    func writeTerminal(_ id: String, data: String) async
}

extension HarnessSocket: TerminalChannel {}

/// The socket's `presence` side (HarnessSocket), as a seam for tests: remembers what this device
/// shows and sends it now (when open) and after every reconnect.
public protocol PresenceChannel: AnyObject, Sendable {
    func setPresence(_ presence: Presence) async
}

extension HarnessSocket: PresenceChannel {}

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
    /// How long a socket rebuilt on foregrounding has to open before the store reports it
    /// disconnected (ms).
    public static let reopenGraceMs: Double = 3000
    /// Activity backfilled after a snapshot: every non-done ticket plus this many newest done.
    public static let activityBackfillDone = 12
    public static let activityConcurrency = 6

    public private(set) var state = BoardState.initial
    /// Bumped on every reconnect so views can refetch what they own.
    public private(set) var epoch = 0
    /// Set when the service rejects the token; the UI offers re-pairing.
    public private(set) var authError: String?
    /// Last snapshot failure (host unreachable etc.), cleared by the next success.
    public private(set) var loadError: String?
    public private(set) var related = Related()
    /// Bumped whenever the socket is rebuilt (foregrounding). A rebuilt socket has no browser
    /// subscriptions, so the Browser tab resubscribes on this as well as on `epoch`.
    public private(set) var socketGeneration = 0
    /// The service's /health from the last refresh that got one (nil until then).
    public private(set) var health: Health?
    /// The plan-usage gauges' last report (GET /usage, then each usage.updated); nil until one arrives.
    /// Held here, not in the reducer: the TS reducer has no usage state to stay in parity with.
    public private(set) var usage: PlanUsageReport?
    /// The service's terminals (GET /terminals, then terminal.* events). Held here, not in the reducer:
    /// the TS reducer has no terminal state to stay in parity with.
    public private(set) var terminals: [TerminalInfo] = []
    /// The chiefs of staff, their Inbox rows and chat entries loaded so far, and the badge (GET /cos,
    /// GET /cos/events/badge, then the cos.* events). Held here, not in the reducer, like the usage.
    public private(set) var cos = CosState()
    /// Change the CoS state: what a view fetched (a page of events, of chat, a chief it opened).
    public func updateCos(_ change: (inout CosState) -> Void) { change(&cos) }
    /// Replace the terminals, as a refetch does (and the snapshot tests).
    public func setTerminals(_ list: [TerminalInfo]) { terminals = list }
    /// Replace the usage report, as a `usage.updated` event does (and the snapshot tests, whose stub client reports none).
    public func setUsage(_ report: PlanUsageReport?) { usage = report }
    /// The release mismatch the person closed: hidden until the service or the app changes.
    public private(set) var dismissedMismatch: ReleaseMismatch?

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
    /// Marks the store disconnected if a socket rebuilt on foregrounding hasn't opened in time.
    @ObservationIgnored private var reopenTimer: TimerHandle?
    @ObservationIgnored private var scope: String
    @ObservationIgnored private var watched: [String: Int] = [:]
    @ObservationIgnored private var listeners: [Int: @MainActor (HarnessEvent) -> Void] = [:]
    @ObservationIgnored private var nextListener = 0
    @ObservationIgnored private var terminalListeners: [Int: @MainActor (ServerMessage) -> Void] = [:]
    @ObservationIgnored private var backgrounded = false
    @ObservationIgnored private var closed = false
    /// Each ticket's message draft (DESIGN.md "Message drafts"), by ticket id: one per ticket for
    /// the store's life, so leaving a ticket keeps what's typed.
    @ObservationIgnored private var messageDrafts: [String: MessageDraftSync] = [:]
    /// What this device shows (`setPresence`), handed to every socket the store opens.
    @ObservationIgnored private var presence: Presence?

    /// - Parameters:
    ///   - boardProject: the board's filter at launch (prefs.boardProject: a project id or a group's scope)
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

    /// Back from the background. While suspended the app heard none of the socket's events, and a
    /// socket the OS dropped may still look open (nothing notices until its next receive fails),
    /// so always rebuild it. Its first connect counts as a reconnect: a snapshot plus an epoch bump,
    /// so open views (a transcript, the spec) refetch what changed meanwhile. The banner keeps
    /// saying connected for a short grace period, so a quick reopen doesn't flash "Reconnecting".
    public func sceneBecameActive() {
        guard backgrounded, !closed else { return }
        backgrounded = false
        closeSocket()
        openSocket(resumed: true)
        guard state.connected else { return }
        reopenTimer = timers.set(Self.reopenGraceMs) { [weak self] in
            guard let self else { return }
            self.reopenTimer = nil
            self.dispatch(.connected(false))
        }
    }

    /// `resumed`: rebuilt on foregrounding, so its first connect bumps the epoch like a reconnect.
    /// A store's first socket doesn't: nothing has loaded yet.
    private func openSocket(resumed: Bool = false) {
        let socket = makeSocket()
        self.socket = socket
        socketGeneration += 1
        var first = !resumed
        let (ops, opsIn) = AsyncStream<BrowserOp>.makeStream()
        outbox = opsIn
        let channel = socket as? any BrowserChannel
        let presenceChannel = socket as? any PresenceChannel
        let terminalChannel = socket as? any TerminalChannel
        // A rebuilt socket (foregrounding) starts without presence: hand it the last one, which it
        // sends once it's open.
        if let presence { opsIn.yield(.presence(presence)) }
        socketTasks = [
            Task {
                for await op in ops {
                    switch op {
                    case let .send(msg): await channel?.send(msg)
                    case let .subscribe(id, tabId, viewerId): await channel?.subscribeBrowser(id, tabId: tabId, viewerId: viewerId)
                    case let .unsubscribe(id, viewerId): await channel?.unsubscribeBrowser(id, viewerId: viewerId)
                    case let .presence(p): await presenceChannel?.setPresence(p)
                    case let .terminal(op):
                        switch op {
                        case let .attach(id, deviceId, cols, rows): await terminalChannel?.attachTerminal(id, deviceId: deviceId, cols: cols, rows: rows)
                        case let .detach(id): await terminalChannel?.detachTerminal(id)
                        case let .resize(id, cols, rows): await terminalChannel?.resizeTerminal(id, cols: cols, rows: rows)
                        case let .write(id, data): await terminalChannel?.writeTerminal(id, data: data)
                        }
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
                guard let terminalChannel else { return }
                for await message in terminalChannel.terminalMessages {
                    guard let self, !Task.isCancelled else { return }
                    for fn in self.terminalListeners.values { fn(message) }
                }
            },
            Task { @MainActor [weak self] in
                for await connected in socket.status {
                    guard let self, !Task.isCancelled else { return }
                    self.clearReopenTimer()
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

    private func clearReopenTimer() {
        if let reopenTimer { timers.clear(reopenTimer) }
        reopenTimer = nil
    }

    private func closeSocket() {
        clearReopenTimer()
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
        if let bus = CosBusEvent(event: event) {
            cos.apply(bus)
            // A chief another device made isn't in the list yet: its count would read as nothing until the next refresh.
            if case let .badge(b) = bus, b.byCos.keys.contains(where: { cos.chiefs[$0] == nil }) {
                let client = client
                Task { [weak self] in
                    if let list = try? await client.listCos() { self?.cos.setChiefs(list) }
                }
            }
        }
        switch event {
        case .usageUpdated(let u): usage = u
        case .terminalCreated, .terminalUpdated, .terminalRemoved: terminals = TerminalList.apply(terminals, event)
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

    // MARK: Terminals

    /// Every terminal.* message from the service (snapshot, output, exit), for the sheet showing it.
    /// Call the returned closure to stop listening.
    @discardableResult
    public func onTerminalMessage(_ fn: @escaping @MainActor (ServerMessage) -> Void) -> @MainActor () -> Void {
        nextListener += 1
        let id = nextListener
        terminalListeners[id] = fn
        return { [weak self] in self?.terminalListeners[id] = nil }
    }

    /// Watch a terminal and report this device's viewport (see HarnessSocket.attachTerminal). The
    /// socket remembers it across reconnects; send it again after the socket is rebuilt (`socketGeneration`).
    public func attachTerminal(_ id: String, deviceId: String, cols: Int, rows: Int) {
        outbox?.yield(.terminal(.attach(id, deviceId: deviceId, cols: cols, rows: rows)))
    }

    public func detachTerminal(_ id: String) { outbox?.yield(.terminal(.detach(id))) }

    public func resizeTerminal(_ id: String, cols: Int, rows: Int) { outbox?.yield(.terminal(.resize(id, cols: cols, rows: rows))) }

    public func writeTerminal(_ id: String, data: String) { outbox?.yield(.terminal(.write(id, data: data))) }

    /// A palette opening: look up every terminal's folder and program, then list them.
    public func refreshTerminals() async {
        if let list = try? await client.listTerminals(refresh: true) { terminals = list }
    }

    /// Create a terminal in `projectId` (nil: All projects) and add it to the list. `openOnMac` asks
    /// a connected Mac to open a pane for it.
    public func createTerminal(projectId: String?, deviceId: String, openOnMac: Bool = true) async throws -> TerminalInfo {
        let info = try await client.createTerminal(CreateTerminalBody(projectId: Patch(projectId), deviceId: deviceId, openOnMac: openOnMac))
        if !terminals.contains(where: { $0.id == info.id }) { terminals.append(info) }
        return info
    }

    /// End a terminal's shell on the service.
    public func closeTerminal(_ id: String) async {
        try? await client.closeTerminal(id)
        terminals.removeAll { $0.id == id }
    }

    // MARK: Browser

    enum BrowserOp: Sendable {
        case send(ClientMessage)
        case subscribe(String, tabId: Int?, viewerId: String?)
        case unsubscribe(String, viewerId: String?)
        case presence(Presence)
        case terminal(TerminalOp)
    }

    enum TerminalOp: Sendable {
        case attach(String, deviceId: String, cols: Int, rows: Int)
        case detach(String)
        case resize(String, cols: Int, rows: Int)
        case write(String, data: String)
    }

    /// Tell the service what this device shows (DESIGN.md "Notifications"), so it holds back
    /// notifications for those tickets while `visible`. Sent in order with the browser messages,
    /// remembered by the socket across its reconnects, and handed to the socket a foregrounding
    /// rebuilds. An unchanged presence isn't sent again.
    public func setPresence(_ presence: Presence) {
        let next = presence.normalized
        guard next != self.presence else { return }
        self.presence = next
        outbox?.yield(.presence(next))
    }

    /// The last presence set (normalized).
    public var currentPresence: Presence? { presence }

    /// Stream a session's browser frames and state (browser.frame / browser.state reach `onEvent`
    /// listeners) on the current socket, on tab `tabId` (nil: the lowest open one); again with
    /// another tab switches to it. Resubscribe when `epoch` or `socketGeneration` changes.
    /// `viewer` names the view (one per BrowserTabModel), so two windows can each watch their own
    /// tab of one session; filter events for it with `isBrowserEvent(_:for:viewerId:)`.
    public func subscribeBrowser(_ sessionId: String, tabId: Int? = nil, viewer: String? = nil) {
        outbox?.yield(.subscribe(sessionId, tabId: tabId, viewerId: viewer))
    }

    /// Stop one viewer's stream; the session's other viewers keep theirs.
    public func unsubscribeBrowser(_ sessionId: String, viewer: String? = nil) {
        outbox?.yield(.unsubscribe(sessionId, viewerId: viewer))
    }

    /// Mouse, key, text, navigation and resize input for a session's browser, sent in call order.
    /// `tabId`: the tab it's for (nil: the tab `viewer` watches). Dropped while the socket is down.
    public func sendBrowserInput(_ sessionId: String, tabId: Int? = nil, viewer: String? = nil, _ input: BrowserInput) {
        outbox?.yield(.send(.browserInput(sessionId: sessionId, tabId: tabId, input: input, viewerId: viewer)))
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

    /// The full snapshot for the current scope. Returns once it's applied; the Activity backfill
    /// it starts runs on its own.
    public func refresh() async {
        // /health is optional: a failure here leaves the last answer (the snapshot reports errors).
        let client = client
        async let health = try? await client.health()
        async let usage = try? await client.getUsage()
        async let terminalList = try? await client.listTerminals(refresh: false)
        async let chiefs = try? await client.listCos()
        async let badge = try? await client.cosBadge()
        do {
            let snapshot = try await loadSnapshot(scope)
            guard !closed else { return }
            if let h = await health { self.health = h }
            if let u = await usage { self.usage = u }
            if let list = await terminalList { self.terminals = list }
            if let list = await chiefs { cos.setChiefs(list) }
            if let b = await badge { cos.badge = b }
            dispatch(.snapshot(snapshot))
            loader.legacy = snapshot.donePage == nil
            loader.snapshotApplied()
            details.reset()
            syncDetails()
            authError = nil
            loadError = nil
            // Not awaited: pull to refresh ends once the snapshot lands.
            Task { await self.backfillActivity(snapshot) }
        } catch {
            guard !closed else { return }
            if Connection.isUnauthorized(error) {
                authError = Connection.describeError(error)
            } else {
                loadError = Connection.describeError(error, baseUrl: baseUrl)
            }
        }
    }

    // MARK: Release

    /// This app and the service come from different releases (`appBuild`: the app's
    /// CFBundleVersion), unless the person closed that notice.
    public func releaseMismatch(appBuild: String?) -> ReleaseMismatch? {
        let m = Releases.mismatch(appBuild: appBuild, serviceRelease: health?.release.optional)
        return m == dismissedMismatch ? nil : m
    }

    public func dismissReleaseMismatch(_ m: ReleaseMismatch) {
        dismissedMismatch = m
    }

    private func loadSnapshot(_ scope: String) async throws -> BoardSnapshot {
        let client = client
        async let projects = client.listProjects()
        async let tickets = client.listTickets(projectId: nil, status: Paging.liveStatuses)
        // A service from before paging answers 404 here (and ignores ?status=, sending every ticket).
        async let donePage: TicketPage? = {
            do {
                let filter = Paging.scopeQuery(scope)
                return try await client.ticketPage(status: .done, projectId: filter.projectId, groupId: filter.groupId, q: nil, limit: Paging.donePageSize, cursor: nil)
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

    private func backfillActivity(_ snapshot: BoardSnapshot) async {
        let done = snapshot.donePage?.page.tickets
            ?? snapshot.tickets.filter { $0.status == .done }.sorted { Paging.completedAtOf($0) > Paging.completedAtOf($1) }
        let wanted = snapshot.tickets.filter { $0.status != .done } + done.prefix(Self.activityBackfillDone)
        let client = client
        var queue = wanted[...]
        await withTaskGroup(of: (String, [ActivityEntry]?).self) { group in
            func next() -> Bool {
                guard let t = queue.popFirst() else { return false }
                group.addTask { (t.sessionId, try? await client.listActivity(t.key)) }
                return true
            }
            for _ in 0..<Self.activityConcurrency { if !next() { break } }
            while let (sessionId, activity) = await group.next() {
                if let activity, !closed { dispatch(.activity(sessionId: sessionId, activity: activity)) }
                _ = next()
            }
        }
    }

    // MARK: Board

    /// The board's filter (a project id, a group's scope, nil for All projects) changed: snapshots
    /// page Done for it; fetches its first page.
    public func setBoardScope(_ board: String?) {
        scope = Paging.scopeOf(board)
        loader.ensureFirstPage(board)
    }

    /// The ticket's message draft (DESIGN.md "Message drafts"): made the first time its composer
    /// shows, from the ticket's saved draft, and kept for the store's life.
    public func messageDraft(for t: Ticket) -> MessageDraftSync {
        if let had = messageDrafts[t.id] {
            had.key = t.key
            return had
        }
        let client = client
        let made = MessageDraftSync(
            key: t.key,
            stored: t.messageDraft.optional,
            save: { key, body in
                guard let api = client as? HarnessClient else { throw MessageDraftError.offline }
                return try await api.saveMessageDraft(key, body)
            },
            onSaved: { [weak self] in self?.dispatch(.tickets([$0])) },
            timers: timers
        )
        messageDrafts[t.id] = made
        return made
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
