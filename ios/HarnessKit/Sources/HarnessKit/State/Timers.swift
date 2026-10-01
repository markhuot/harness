import Foundation

/// A pending one-shot timer from `Timers.set`, for `Timers.clear`.
public struct TimerHandle: Hashable, Sendable {
    public let id: Int
    public init(id: Int) { self.id = id }
}

/// One-shot timers, injectable so debounces, retries and polling run without real waiting in tests
/// (the `Timers` seam of mobile/src/lib/boardLoader.ts: `set(fn, ms)` / `clear(handle)`).
/// Main-actor bound: every stateful type that uses it (BoardLoader, DraftSync, BoardStore) lives
/// on the main actor, and callbacks fire there.
@MainActor
public protocol Timers: AnyObject {
    /// Run `fire` once after `ms` milliseconds unless cleared first.
    @discardableResult
    func set(_ ms: Double, _ fire: @escaping @MainActor () -> Void) -> TimerHandle
    func clear(_ handle: TimerHandle)
}

/// Real timers on `Task.sleep`.
@MainActor
public final class TaskTimers: Timers {
    private var next = 0
    private var tasks: [Int: Task<Void, Never>] = [:]

    public init() {}

    @discardableResult
    public func set(_ ms: Double, _ fire: @escaping @MainActor () -> Void) -> TimerHandle {
        next += 1
        let id = next
        tasks[id] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(max(0, ms)))
            guard !Task.isCancelled, let self, self.tasks.removeValue(forKey: id) != nil else { return }
            fire()
        }
        return TimerHandle(id: id)
    }

    public func clear(_ handle: TimerHandle) {
        tasks.removeValue(forKey: handle.id)?.cancel()
    }
}

/// Timers driven by hand: nothing fires until `advance(by:)` moves the clock past its due time, or
/// `fireAll()`. Due timers fire in due order (then creation order), and a timer set while
/// advancing fires in the same call when it falls due inside the window. For tests and previews.
@MainActor
public final class ManualTimers: Timers {
    private struct Pending {
        let id: Int
        let due: Double
        let fire: @MainActor () -> Void
    }

    /// Milliseconds since this clock was made.
    public private(set) var now: Double = 0
    private var next = 0
    private var pending: [Pending] = []

    public init() {}

    /// How many timers are waiting.
    public var count: Int { pending.count }
    /// Delays (ms from now) of the waiting timers, soonest first.
    public var delays: [Double] { pending.map { $0.due - now }.sorted() }

    @discardableResult
    public func set(_ ms: Double, _ fire: @escaping @MainActor () -> Void) -> TimerHandle {
        next += 1
        pending.append(Pending(id: next, due: now + max(0, ms), fire: fire))
        return TimerHandle(id: next)
    }

    public func clear(_ handle: TimerHandle) {
        pending.removeAll { $0.id == handle.id }
    }

    /// Move the clock forward, firing every timer that falls due on the way.
    public func advance(by ms: Double) {
        let end = now + ms
        while let i = soonest(), pending[i].due <= end {
            let t = pending.remove(at: i)
            now = t.due
            t.fire()
        }
        now = end
    }

    /// Fire every waiting timer (and any they set) regardless of due time.
    public func fireAll() {
        var guardCount = 0
        while let i = soonest(), guardCount < 10_000 {
            guardCount += 1
            let t = pending.remove(at: i)
            now = max(now, t.due)
            t.fire()
        }
    }

    private func soonest() -> Int? {
        pending.indices.min { a, b in
            pending[a].due < pending[b].due || (pending[a].due == pending[b].due && pending[a].id < pending[b].id)
        }
    }
}
