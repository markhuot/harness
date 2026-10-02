import HarnessKit
import SwiftUI

/// Run a request; on failure play the error haptic and toast
/// `describeError(e, baseUrl)`; on success toast `okMessage` (info) when given.
///
/// ```swift
/// @Environment(Actions.self) private var actions
/// Button("Start") { actions.perform("Started") { try await store.client.startTicket(key) } }
/// ```
@MainActor
@Observable
final class Actions {
    @ObservationIgnored let toasts: ToastCenter
    @ObservationIgnored private let baseUrl: @MainActor () -> String?

    init(toasts: ToastCenter, baseUrl: @escaping @MainActor () -> String?) {
        self.toasts = toasts
        self.baseUrl = baseUrl
    }

    /// Awaitable form: the result, or nil after a failure (already reported).
    @discardableResult
    func run<T>(_ okMessage: String? = nil, _ fn: () async throws -> T) async -> T? {
        do {
            let out = try await fn()
            if let okMessage { toasts.show(okMessage, kind: .info) }
            return out
        } catch {
            haptic(.error)
            toasts.show(Connection.describeError(error, baseUrl: baseUrl()), kind: .error)
            return nil
        }
    }

    /// Fire-and-forget form, for button actions.
    func perform(_ okMessage: String? = nil, _ fn: @escaping @MainActor () async throws -> Void) {
        Task { await run(okMessage, fn) }
    }
}
