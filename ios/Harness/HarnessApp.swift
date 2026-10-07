import HarnessKit
import SwiftUI

@main
struct HarnessApp: App {
    /// APNs callbacks and the notification center's delegate (Notifications.swift).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app: AppModel
    @State private var actions = Actions()
    @State private var widgets: WidgetSync
    /// The app's phase across all its windows: active while any window is, background once none is.
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let app = AppModel(storage: KeychainStorage())
        _app = State(initialValue: app)
        // Synchronous and quick: the Keychain holds a few small items. Loading before the first
        // frame keeps a cold start from flashing Connect before the saved server appears.
        app.load()
        let widgets = WidgetSync(app: app)
        _widgets = State(initialValue: widgets)
        widgets.start()
        // Asks for notification permission and an APNs token, then registers it with every saved Mac.
        PushCenter.shared.start(app)
    }

    var body: some Scene {
        // The main window (more than one on iPad), each with its own Router (MainWindow).
        WindowGroup {
            MainWindow()
                .environment(app)
                .environment(actions)
        }
        .handlesExternalEvents(matching: ["\(DeepLink.scheme)://"])
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                app.sceneBecameActive()
                PushCenter.shared.sync()
                Task { await PushCenter.shared.refreshAuthorization() }
            case .background:
                PushCenter.shared.holdForPresence()
                app.sceneDidEnterBackground()
            default: break
            }
        }
        // A Mac paired, paired again or forgotten: register with any that don't have this device.
        .onChange(of: app.connectionKey) { PushCenter.shared.sync() }
        .onChange(of: app.servers) { PushCenter.shared.sync() }

        // A ticket in a window of its own (iPad): opened by tapping a ticket at regular width or by
        // Open in New Window, saved with the scene so a relaunch reopens it (Windows.swift).
        WindowGroup("Ticket", id: SceneID.ticket, for: TicketWindowValue.self) { $value in
            TicketWindowRoot(value: $value)
                .environment(app)
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
