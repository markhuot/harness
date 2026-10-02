import Foundation
import Synchronization

/// A promise the test settles by hand: fakes hand one out per request and the test resolves or
/// rejects it when it wants the answer to land (the `deferred()` helper of the bun tests).
final class Deferred<T: Sendable>: Sendable {
    private struct State {
        var result: Result<T, any Error>?
        var waiters: [CheckedContinuation<T, any Error>] = []
    }

    private let state = Mutex(State())

    var isSettled: Bool { state.withLock { $0.result != nil } }

    func value() async throws -> T {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, any Error>) in
            let ready: Result<T, any Error>? = state.withLock { s in
                if let r = s.result { return r }
                s.waiters.append(c)
                return nil
            }
            if let ready { c.resume(with: ready) }
        }
    }

    func resolve(_ value: T) { settle(.success(value)) }
    func reject(_ error: any Error) { settle(.failure(error)) }

    private func settle(_ r: Result<T, any Error>) {
        let waiters = state.withLock { s -> [CheckedContinuation<T, any Error>] in
            guard s.result == nil else { return [] }
            s.result = r
            defer { s.waiters = [] }
            return s.waiters
        }
        for w in waiters { w.resume(with: r) }
    }
}

/// A thread-safe list a fake appends its calls to.
final class CallLog<T: Sendable>: Sendable {
    private let items = Mutex<[T]>([])
    func append(_ x: T) { items.withLock { $0.append(x) } }
    var all: [T] { items.withLock { $0 } }
    var count: Int { items.withLock { $0.count } }
    subscript(i: Int) -> T { items.withLock { $0[i] } }
    var last: T? { items.withLock { $0.last } }
}

/// A message-only error, like `new Error("offline")`.
struct TestError: LocalizedError, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Let tasks started on other executors run until `condition` holds (fails the wait after ~2 s).
@discardableResult
func eventually(_ condition: @MainActor () -> Bool, timeout: Duration = .seconds(2)) async -> Bool {
    let clock = ContinuousClock()
    let end = clock.now + timeout
    while clock.now < end {
        if await condition() { return true }
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(1))
    }
    return await condition()
}

/// Give in-flight tasks a moment, for checks that nothing (more) happens.
func settle() async {
    for _ in 0..<5 {
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(4))
    }
}
