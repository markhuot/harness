import HarnessKit
import SwiftUI

/// Run a request; on failure play the error haptic. The screen shows the result itself (the board
/// and ticket update over the socket), so nothing else is posted.
///
/// ```swift
/// @Environment(Actions.self) private var actions
/// Button("Start") { actions.perform { try await store.client.startTicket(key) } }
/// ```
@MainActor
@Observable
final class Actions {
    /// Awaitable form: the result, or nil after a failure (already reported).
    @discardableResult
    func run<T>(_ fn: () async throws -> T) async -> T? {
        do {
            return try await fn()
        } catch {
            haptic(.error)
            return nil
        }
    }

    /// Fire-and-forget form, for button actions.
    func perform(_ fn: @escaping @MainActor () async throws -> Void) {
        Task { await run(fn) }
    }
}
