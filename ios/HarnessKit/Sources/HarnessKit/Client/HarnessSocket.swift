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
/// that sends), it re-sends `browser.subscribe` for every remembered subscription, resets the
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
    /// Ordered so re-subscribes go out in the order they were made.
    private var browserSubs: [String] = []

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
                for id in browserSubs {
                    try await conn.send(Self.encode(.browserSubscribe(sessionId: id)))
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
        if case let .event(event) = msg { eventsOut.yield(event) }
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

    /// Stream this session's browser frames; remembered and re-sent on every reconnect.
    public func subscribeBrowser(_ sessionId: String) async {
        if !browserSubs.contains(sessionId) { browserSubs.append(sessionId) }
        await send(.browserSubscribe(sessionId: sessionId))
    }

    public func unsubscribeBrowser(_ sessionId: String) async {
        browserSubs.removeAll { $0 == sessionId }
        await send(.browserUnsubscribe(sessionId: sessionId))
    }

    /// Stop for good: closes the connection, interrupts a reconnect wait, then finishes `events`
    /// and `status` (after a final `false` if a connection was open).
    public func close() {
        closed = true
        current?.close()
        runner.withLock { $0?.cancel() }
    }
}
