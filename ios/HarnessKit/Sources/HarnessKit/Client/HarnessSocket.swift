import Foundation
import Synchronization

/// One frame from the service.
public enum WebSocketFrame: Sendable, Equatable {
    case text(String)
    case data(Data)
}

/// One WebSocket connection, abstracted so HarnessSocket can be tested with scripted connections
/// (no sockets). `URLSessionWebSocketConnection` is the real one.
///
/// A connection starts connecting when it's made. `send` waits for the handshake and throws when
/// the connection can't be opened or has closed; `receive` throws once it has closed.
public protocol WebSocketConnection: Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> WebSocketFrame
    func close()
}

/// Makes the connection for one attempt.
public typealias WebSocketFactory = @Sendable (URL) -> any WebSocketConnection

/// `URLSessionWebSocketTask` as a `WebSocketConnection`.
public final class URLSessionWebSocketConnection: WebSocketConnection {
    let task: URLSessionWebSocketTask

    public init(url: URL, session: URLSession = .shared) {
        task = session.webSocketTask(with: url)
        task.resume()
    }

    public static let factory: WebSocketFactory = { URLSessionWebSocketConnection(url: $0) }

    public func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    public func receive() async throws -> WebSocketFrame {
        switch try await task.receive() {
        case let .string(s): return .text(s)
        case let .data(d): return .data(d)
        @unknown default: return .data(Data())
        }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

/// The live event stream: the port of HarnessSocket in shared/src/client.ts.
///
/// It connects as soon as it's made and reconnects until `close()`. On open (the first `hello`
/// that sends), it re-sends `browser.subscribe` for every remembered subscription (on the tab it was
/// last on: each incoming browser.state for a subscribed session updates it), resets the
/// backoff and reports connected. When the connection fails or drops it reports disconnected,
/// waits `ReconnectBackoff.next()` (250 ms doubling to 5 s) and tries again.
///
/// An actor because it owns mutable state (the current connection, subscriptions, backoff) that
/// both the reconnect loop and callers (`send`, `subscribeBrowser`, `close`) touch.
///
/// Call `close()` when done: the reconnect loop keeps the socket alive until then.
public actor HarnessSocket {
    public typealias Sleep = @Sendable (Duration) async throws -> Void

    public let url: String
    /// Every `event` message's HarnessEvent. Other messages (welcome, pong, error) and frames that
    /// don't decode are skipped. Finishes after `close()`.
    public nonisolated let events: AsyncStream<HarnessEvent>
    /// Connection changes, on transitions only: `true` when a connection opens, `false` when an open
    /// one drops (or is closed). The socket starts disconnected, so failed attempts before the first
    /// open, and repeated failures while down, emit nothing (TS calls onStatus(false) on every
    /// failed attempt). Finishes after `close()`.
    public nonisolated let status: AsyncStream<Bool>

    private let factory: WebSocketFactory
    private let sleep: Sleep
    private let eventsOut: AsyncStream<HarnessEvent>.Continuation
    private let statusOut: AsyncStream<Bool>.Continuation
    private let runner = Mutex<Task<Void, Never>?>(nil)

    private var current: (any WebSocketConnection)?
    private var open = false
    private var closed = false
    private var connected = false
    private var backoff = ReconnectBackoff()
    /// One entry per viewer (session + viewer id, nil for a socket-wide viewer) with the tab it's on
    /// (nil: the lowest open one), ordered so re-subscribes go out in the order they were made.
    private var browserSubs: [BrowserSubscription] = []

    public init(url: String, factory: @escaping WebSocketFactory = URLSessionWebSocketConnection.factory, sleep: @escaping Sleep = { try await Task.sleep(for: $0) }) {
        self.url = url
        self.factory = factory
        self.sleep = sleep
        (events, eventsOut) = AsyncStream.makeStream(of: HarnessEvent.self)
        (status, statusOut) = AsyncStream.makeStream(of: Bool.self)
        runner.withLock { $0 = Task { await self.run() } }
    }

    /// Whether a connection is open now.
    public var isConnected: Bool { connected }

    private func run() async {
        defer {
            eventsOut.finish()
            statusOut.finish()
        }
        guard let url = URL(string: url) else { return }
        while !closed {
            let conn = factory(url)
            current = conn
            do {
                try await conn.send(Self.encode(.hello(client: HarnessKit.clientName)))
                guard !closed else { throw CancellationError() }
                // Open: from here `send` goes through, so a subscribe made while re-subscribing
                // isn't lost (at worst it's sent twice, which the service tolerates).
                open = true
                for sub in browserSubs {
                    try await conn.send(Self.encode(.browserSubscribe(sessionId: sub.sessionId, tabId: sub.tabId, viewerId: sub.viewerId)))
                }
                backoff.reset()
                setConnected(true)
                while true { handle(try await conn.receive()) }
            } catch {}
            conn.close()
            open = false
            current = nil
            setConnected(false)
            if closed { break }
            do { try await sleep(backoff.next()) } catch { break }
        }
    }

    private func handle(_ frame: WebSocketFrame) {
        let data: Data
        switch frame {
        case let .text(s): data = Data(s.utf8)
        case let .data(d): data = d
        }
        guard let msg = try? JSONDecoder().decode(ServerMessage.self, from: data) else { return }
        guard case let .event(event) = msg else { return }
        // The service moves a subscription between tabs itself (newTab, closing the watched tab):
        // follow it, so a reconnect comes back to the same tab. TS leaves this to its caller
        // (noteBrowserTab).
        if case let .browserState(sessionId, state, viewerId) = event { noteBrowserTab(sessionId, tabId: state.tabId, viewerId: viewerId) }
        eventsOut.yield(event)
    }

    private func setConnected(_ value: Bool) {
        guard value != connected else { return }
        connected = value
        statusOut.yield(value)
    }

    static func encode(_ msg: ClientMessage) -> String {
        // ClientMessage always encodes (strings and BrowserInput values).
        (try? String(decoding: JSONEncoder().encode(msg), as: UTF8.self)) ?? "{}"
    }

    /// Sends when a connection is open; otherwise dropped, as in TS (`readyState === 1`).
    public func send(_ msg: ClientMessage) async {
        guard open, let conn = current else { return }
        try? await conn.send(Self.encode(msg))
    }

    /// Stream this session's browser frames; again with another `tabId` switches tabs. Remembered
    /// (with its tab) and re-sent on every reconnect. `viewerId` names this view, so several views
    /// of one session (torn-off browser tabs) each watch their own tab over this one socket.
    public func subscribeBrowser(_ sessionId: String, tabId: Int? = nil, viewerId: String? = nil) async {
        if let i = browserSubs.firstIndex(where: { $0.is(sessionId, viewerId) }) {
            browserSubs[i].tabId = tabId
        } else {
            browserSubs.append(BrowserSubscription(sessionId: sessionId, viewerId: viewerId, tabId: tabId))
        }
        await send(.browserSubscribe(sessionId: sessionId, tabId: tabId, viewerId: viewerId))
    }

    /// Remember the tab a viewer's subscription is on, for reconnects (no-op when not subscribed).
    /// A state without a viewer (an older service) moves every viewer of the session, since that
    /// service has only one subscription per socket.
    public func noteBrowserTab(_ sessionId: String, tabId: Int?, viewerId: String? = nil) {
        for i in browserSubs.indices where browserSubs[i].sessionId == sessionId && (viewerId == nil || browserSubs[i].viewerId == viewerId) {
            browserSubs[i].tabId = tabId
        }
    }

    /// Every remembered subscription, in subscription order (for tests).
    var browserSubscriptions: [BrowserSubscription] { browserSubs }

    /// Stop this viewer's stream; other viewers of the session keep theirs.
    public func unsubscribeBrowser(_ sessionId: String, viewerId: String? = nil) async {
        browserSubs.removeAll { $0.is(sessionId, viewerId) }
        await send(.browserUnsubscribe(sessionId: sessionId, viewerId: viewerId))
    }

    /// Stop for good: closes the connection, interrupts a reconnect wait, then finishes `events`
    /// and `status` (after a final `false` if a connection was open).
    public func close() {
        closed = true
        current?.close()
        runner.withLock { $0?.cancel() }
    }
}

/// One remembered `browser.subscribe`: a viewer of a session's browser and the tab it's on.
struct BrowserSubscription: Sendable, Equatable {
    var sessionId: String
    var viewerId: String?
    var tabId: Int?

    func `is`(_ sessionId: String, _ viewerId: String?) -> Bool { self.sessionId == sessionId && self.viewerId == viewerId }
}

/// Whether a browser.frame/browser.state event is for this viewer of `sessionId`: the port of
/// `isBrowserEventFor` in shared/src/client.ts. An event that names a viewer is for that viewer
/// only; one without (an older service, or a viewer that sent no id) is for every viewer of the
/// session.
public func isBrowserEvent(_ event: HarnessEvent, for sessionId: String, viewerId: String?) -> Bool {
    switch event {
    case let .browserFrame(id, _, _, _, _, v), let .browserState(id, _, v):
        id == sessionId && (v == nil || v == viewerId)
    default:
        false
    }
}
