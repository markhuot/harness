import HarnessKit
import SwiftUI
import UIKit
import UserNotifications

// System notifications (DESIGN.md "Notifications"). The service on the Mac decides what to push and
// sends it through APNs; the system shows it however Settings → Notifications says. The app only
// registers its token with every saved Mac (PushRegistrar), tells the active Mac what's on screen
// (presence, so it holds back notifications for those tickets), and opens the ticket a tapped
// notification names.

/// UIKit's side: the APNs token callbacks, and the notification center's delegate (set before
/// launch finishes, so a tap that cold-launches the app reaches it).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCenter.shared.didRegister(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        PushCenter.shared.didFailToRegister(error)
    }

    /// In the foreground too: the service already left out what's on screen.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// A tap: open the ticket it's about.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let link = Push.link(response.notification.request.content.userInfo) else { return }
        await MainActor.run { WindowDirectory.shared.openFromNotification(link) }
    }
}

/// The app's push state: the registrar, the presence tracker and the permission, for the
/// AppDelegate, the windows and Settings.
@MainActor
@Observable
final class PushCenter {
    static let shared = PushCenter()

    /// The system permission, for Settings (refreshed at launch and on every foregrounding).
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var registrar: PushRegistrar?
    /// Set when registering with APNs failed (no entitlement, no network), for Settings.
    private(set) var registrationError: String?
    @ObservationIgnored private(set) var tracker: PresenceTracker?
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    /// `-HarnessSkipNotificationPrompt YES` (or the same default written with `simctl spawn …
    /// defaults write`) skips the permission alert, for automated runs that it would cover.
    private var skipsPrompt: Bool { UserDefaults.standard.bool(forKey: "HarnessSkipNotificationPrompt") }

    /// Wires push into `app` and asks for permission (the system asks once; after that this just
    /// reads the answer) and for a token. Call once, at launch.
    func start(_ app: AppModel) {
        guard self.app == nil else { return }
        self.app = app
        let deviceId = app.deviceId()
        registrar = PushRegistrar(deviceId: deviceId, name: UIDevice.current.name, environment: Self.environment)
        tracker = PresenceTracker(deviceId: deviceId) { [weak app] in app?.setPresence($0) }
        app.willForget = { [weak self] server in
            guard let registrar = self?.registrar else { return }
            Task { await registrar.unregister(server) }
        }
        Task {
            if !skipsPrompt {
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            }
            await refreshAuthorization()
            // A token comes whatever the permission; without it nothing shows, but asking later in
            // Settings shouldn't need a relaunch to register.
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(token: Data) {
        registrationError = nil
        guard let registrar, let app else { return }
        let servers = app.savedConnections()
        Task { await registrar.setToken(Push.hexToken(token), servers: servers) }
    }

    func didFailToRegister(_ error: any Error) {
        registrationError = error.localizedDescription
    }

    /// Registers with any saved Mac that doesn't have this device yet: after pairing, on a new
    /// connection, and on foregrounding (a Mac that was unreachable before).
    func sync() {
        guard let registrar, let app else { return }
        let servers = app.savedConnections()
        Task { await registrar.sync(servers) }
    }

    func refreshAuthorization() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if status != authorization { authorization = status }
    }

    /// The app is going to the background: the windows' presence (visible: false) is on its way
    /// out over the socket. Hold off suspension a moment so it gets there; otherwise the Mac would
    /// keep holding back notifications for what was on screen.
    func holdForPresence() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "presence") { [weak self] in self?.endHold() }
        Task {
            try? await Task.sleep(for: .seconds(2))
            endHold()
        }
    }

    private func endHold() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// Which APNs environment this build's token is for (Push.environment).
    static var environment: ApnsEnvironment {
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        #endif
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        return Push.environment(provisioningProfile: profile, simulator: simulator)
    }
}

extension View {
    /// Reports this window's phase and the tickets it shows (PresenceRules) to the presence
    /// tracker while it's open.
    func reportsPresence(_ router: Router) -> some View {
        background(PresenceProbe(router: router))
    }
}

/// An empty view of its own, so the board's changes re-run only this body, not the window's.
private struct PresenceProbe: View {
    let router: Router

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var phase
    @State private var id = UUID().uuidString

    var body: some View {
        Color.clear
            .accessibilityHidden(true)
            .allowsHitTesting(false)
            .onChange(of: report, initial: true) { _, r in PushCenter.shared.tracker?.update(id, r) }
            .onDisappear { PushCenter.shared.tracker?.remove(id) }
    }

    private var report: ScenePresence {
        let p: ScenePresence.Phase = switch phase {
        case .active: .active
        case .inactive: .inactive
        default: .background
        }
        guard app.active != nil, let store = app.store else { return ScenePresence(phase: p, tickets: []) }
        let prefs = app.prefs
        return ScenePresence(phase: p, tickets: PresenceRules.tickets(router) { BoardColumns.shownKeys(store.state, prefs: prefs) })
    }
}
