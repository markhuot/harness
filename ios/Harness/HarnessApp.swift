import HarnessKit
import SwiftUI

@main
struct HarnessApp: App {
    @State private var app: AppModel
    @State private var toasts: ToastCenter
    @State private var actions: Actions
    /// The app's phase across all its windows: active while any window is, background once none is.
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let app = AppModel(storage: KeychainStorage())
        let toasts = ToastCenter()
        _app = State(initialValue: app)
        _toasts = State(initialValue: toasts)
        _actions = State(initialValue: Actions(toasts: toasts, baseUrl: { [weak app] in app?.active?.baseUrl }))
        // Synchronous and quick: the Keychain holds a few small items. Loading before the first
        // frame keeps a cold start from flashing Connect before the saved server appears.
        app.load()
    }

    var body: some Scene {
        // The main window (more than one on iPad), each with its own Router (MainWindow).
        WindowGroup {
            MainWindow()
                .environment(app)
                .environment(toasts)
                .environment(actions)
        }
        .handlesExternalEvents(matching: ["\(DeepLink.scheme)://"])
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: app.sceneBecameActive()
            case .background: app.sceneDidEnterBackground()
            default: break
            }
        }

        // A ticket in a window of its own (iPad): opened by tapping a ticket at regular width or by
        // Open in New Window, saved with the scene so a relaunch reopens it (Windows.swift).
        WindowGroup("Ticket", id: SceneID.ticket, for: TicketWindowValue.self) { $value in
            TicketWindowRoot(value: $value)
                .environment(app)
                .environment(toasts)
                .environment(actions)
        }
        .handlesExternalEvents(matching: [TicketWindowValue.sceneMatch])
    }
}

/// One main window: RootView with the window's own Router.
private struct MainWindow: View {
    @State private var router = Router()

    var body: some View {
        RootView().environment(router)
    }
}
