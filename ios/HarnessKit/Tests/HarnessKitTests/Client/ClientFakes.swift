import Foundation
import Synchronization
import Testing
@testable import HarnessKit

/// Records every request and answers with `respond` (default: `{ "data": [] }`).
final class FakeTransport: HTTPTransport {
    private let log = Mutex<[HTTPRequest]>([])
    private let respond: @Sendable (HTTPRequest) -> HTTPResponse

    init(_ respond: @escaping @Sendable (HTTPRequest) -> HTTPResponse = { _ in HTTPResponse(status: 200, body: Data(#"{"data":[]}"#.utf8)) }) {
        self.respond = respond
    }

    /// Always answers `status` with `body`.
    convenience init(status: Int, body: String) {
        self.init { _ in HTTPResponse(status: status, body: Data(body.utf8)) }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        log.withLock { $0.append(request) }
        return respond(request)
    }

    var requests: [HTTPRequest] { log.withLock { $0 } }
    var last: HTTPRequest? { requests.last }
}

struct ConnectionClosed: Error {}

/// A scripted WebSocket. `refuse` makes the first send (the hello) throw, like a failed handshake.
/// `push` delivers a frame; `drop` closes it from the server side.
final class FakeConnection: WebSocketConnection {
    struct State {
        var sent: [String] = []
        var inbox: [WebSocketFrame] = []
        var waiter: CheckedContinuation<WebSocketFrame, any Error>?
        var closed = false
        var closeCalls = 0
    }

    let refuse: Bool
    private let state = Mutex(State())
    /// With `holdHandshake`, the first send waits here until `completeHandshake()`.
    private let handshake = Mutex<(held: Bool, waiter: CheckedContinuation<Void, Never>?, waiting: Bool)>((false, nil, false))

    init(refuse: Bool = false, holdHandshake: Bool = false) {
        self.refuse = refuse
        handshake.withLock { $0.held = holdHandshake }
    }

    /// The first send is parked (the handshake is in flight).
    var handshakeWaiting: Bool { handshake.withLock { $0.waiting } }

    func completeHandshake() {
        handshake.withLock { h in
            h.held = false
            h.waiting = false
            h.waiter?.resume()
            h.waiter = nil
        }
    }

    func send(_ text: String) async throws {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            handshake.withLock { h in
                // Only the first send (the hello) is parked; later ones pass straight through.
                if h.held && !h.waiting { h.waiter = c; h.waiting = true } else { c.resume() }
            }
        }
        try state.withLock { s in
            if refuse || s.closed { throw ConnectionClosed() }
            s.sent.append(text)
        }
    }

    func receive() async throws -> WebSocketFrame {
        try await withCheckedThrowingContinuation { c in
            state.withLock { s in
                if !s.inbox.isEmpty { c.resume(returning: s.inbox.removeFirst()) }
                else if s.closed { c.resume(throwing: ConnectionClosed()) }
                else { s.waiter = c }
            }
        }
    }

    func close() {
        state.withLock { $0.closeCalls += 1 }
        drop()
    }

    func push(_ frame: WebSocketFrame) {
        state.withLock { s in
            if let w = s.waiter { s.waiter = nil; w.resume(returning: frame) } else { s.inbox.append(frame) }
        }
    }

    func push(_ text: String) { push(.text(text)) }

    func drop() {
        state.withLock { s in
            s.closed = true
            if let w = s.waiter { s.waiter = nil; w.resume(throwing: ConnectionClosed()) }
        }
    }

    var sent: [String] { state.withLock { $0.sent } }
    var sentMessages: [ClientMessage] { sent.map { try! JSONDecoder().decode(ClientMessage.self, from: Data($0.utf8)) } }
    var closeCalls: Int { state.withLock { $0.closeCalls } }
}

/// Hands out the scripted connections in order, then refusing ones. Records every URL.
final class FakeSocketFactory: Sendable {
    private struct State {
        var scripted: [FakeConnection]
        var made: [FakeConnection] = []
        var urls: [URL] = []
    }

    private let state: Mutex<State>

    init(_ scripted: [FakeConnection] = []) { state = Mutex(State(scripted: scripted)) }

    var factory: WebSocketFactory {
        { [self] url in
            state.withLock { s in
                let conn = s.scripted.isEmpty ? FakeConnection(refuse: true) : s.scripted.removeFirst()
                s.made.append(conn)
                s.urls.append(url)
                return conn
            }
        }
    }

    var made: [FakeConnection] { state.withLock { $0.made } }
    var urls: [URL] { state.withLock { $0.urls } }
}

/// A sleep that only ends when the test calls `advance()` (or the task is cancelled).
final class ManualSleep: Sendable {
    private struct State {
        var requested: [Duration] = []
        var waiters: [(id: Int, c: CheckedContinuation<Void, any Error>)] = []
        var cancelledEarly: Set<Int> = []
        var cancellations = 0
        var nextId = 0
    }

    private let state = Mutex(State())

    var sleep: HarnessSocket.Sleep {
        { [self] d in try await wait(d) }
    }

    private func wait(_ d: Duration) async throws {
        let id = state.withLock { s in
            s.nextId += 1
            return s.nextId
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
                state.withLock { s in
                    if s.cancelledEarly.remove(id) != nil {
                        c.resume(throwing: CancellationError())
                    } else {
                        s.requested.append(d)
                        s.waiters.append((id, c))
                    }
                }
            }
        } onCancel: {
            state.withLock { s in
                s.cancellations += 1
                if let i = s.waiters.firstIndex(where: { $0.id == id }) {
                    s.waiters.remove(at: i).c.resume(throwing: CancellationError())
                } else {
                    s.cancelledEarly.insert(id)
                }
            }
        }
    }

    /// Ends the oldest pending sleep.
    func advance() {
        state.withLock { s in
            if !s.waiters.isEmpty { s.waiters.removeFirst().c.resume() }
        }
    }

    var requested: [Duration] { state.withLock { $0.requested } }
    var pending: Int { state.withLock { $0.waiters.count } }
    var cancellations: Int { state.withLock { $0.cancellations } }
}

/// Collects an AsyncStream's elements in the background.
final class Recorder<T: Sendable>: Sendable {
    private let state = Mutex<(items: [T], finished: Bool)>(([], false))

    init(_ stream: AsyncStream<T>) {
        Task { [self] in
            for await x in stream { self.state.withLock { $0.items.append(x) } }
            self.state.withLock { $0.finished = true }
        }
    }

    var items: [T] { state.withLock { $0.items } }
    var finished: Bool { state.withLock { $0.finished } }
}

/// Polls `condition` until it holds (a sync point for actor hops, not a timer under test).
func eventually(_ what: String, timeout: Duration = .seconds(3), sourceLocation: SourceLocation = #_sourceLocation, _ condition: @Sendable () async -> Bool) async {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while clock.now < deadline {
        if await condition() { return }
        try? await Task.sleep(for: .milliseconds(1))
    }
    Issue.record("Timed out waiting for: \(what)", sourceLocation: sourceLocation)
}

/// The first sample of a protocol.ts type from Fixtures/protocol.json, as raw JSON.
func protocolSample(_ type: String, _ index: Int = 0) throws -> JSONValue {
    let all = try Fixture.value("protocol", type, as: [JSONValue].self)
    return all[index]
}

/// `{ "data": sample }`.
func envelope(_ value: JSONValue) throws -> String {
    String(decoding: try JSONEncoder().encode(JSONValue.object(["data": value])), as: UTF8.self)
}

/// A request body as JSON, for key-order-insensitive comparison.
func bodyJSON(_ request: HTTPRequest?) throws -> JSONValue? {
    guard let body = request?.body else { return nil }
    return try JSONDecoder().decode(JSONValue.self, from: body)
}

func json(_ text: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}
