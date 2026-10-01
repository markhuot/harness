import HarnessKit
import SwiftUI

@main
struct HarnessApp: App {
    @State private var app: AppModel
    @State private var router = Router()
    @State private var toasts: ToastCenter
    @State private var actions: Actions

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
        WindowGroup {
            RootView()
                .environment(app)
                .environment(router)
                .environment(toasts)
                .environment(actions)
        }
    }
}
