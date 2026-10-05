import HarnessKit
import Observation
import WidgetKit

/// Keeps the home screen widgets (ios/Widgets) in step with the app: the active server and a
/// snapshot of the board's active tickets go into the App Group, and the widgets reload when what
/// they show changes (WidgetSyncState decides). A burst of board events syncs once. The widgets also fetch from the service on their own every 15 minutes.
@MainActor
final class WidgetSync {
    private let app: AppModel
    private let shared = WidgetShared.appGroup()
    private var written: WidgetSyncState?
    private var pending: Task<Void, Never>?

    init(app: AppModel) {
        self.app = app
    }

    func start() {
        guard shared != nil else { return }
        observe()
    }

    /// Re-arms on every change to what `current()` reads (Observation fires once per registration).
    private func observe() {
        withObservationTracking {
            _ = current()
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.schedule()
                self?.observe()
            }
        }
        schedule()
    }

    private func current() -> WidgetSyncState {
        WidgetSyncState.current(active: app.active, prefs: app.prefs, board: app.store?.state, now: Date.now.timeIntervalSince1970 * 1000)
    }

    /// At most one sync a second. Not a debounce: streaming transcript text changes the board many
    /// times a second for minutes, and a debounce would never fire.
    private func schedule() {
        guard pending == nil else { return }
        pending = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1))
            self?.pending = nil
            self?.sync()
        }
    }

    private func sync() {
        guard let shared else { return }
        let next = current()
        let plan = next.plan(from: written)
        do {
            if case let .some(host) = plan.host { try shared.writeHost(host) }
            if case let .some(snapshot) = plan.snapshot { try shared.writeSnapshot(snapshot) }
        } catch {
            // The next change tries again; a widget keeps showing what it had meanwhile.
            return
        }
        written = next.written(after: written)
        if plan.reload { WidgetCenter.shared.reloadAllTimelines() }
    }
}
