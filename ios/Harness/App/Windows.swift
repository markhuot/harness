import HarnessKit
import SwiftUI
import UIKit

// The iPad's windows (ARCHITECTURE.md § App shell, Windows): any number of main windows (RootView,
// each with its own Router) and ticket windows (TicketWindowRoot, keyed by TicketWindowValue).
// AppModel, the BoardStore and Actions are shared by all of them. On iPad at regular
// width, opening a ticket opens (or brings forward) its window. A pinned ticket window is one
// torn-off tab (or browser tab, or the composer): the ticket's other windows read which ones are
// open (WindowDirectory.tornOff) and show Return to this window in their place.

/// The scene ids HarnessApp's WindowGroups use.
enum SceneID {
    static let ticket = "ticket"
}

/// The open windows: main windows, most recently active last, so a ticket window can send a
/// section link (harness://board, …) to one and bring it forward; ticket windows by key, so
/// tapping a ticket whose window is open brings that window forward instead of opening another;
/// and the pinned windows that are open (`pinned`, observed), read from the app's open scene
/// sessions, so a relaunch knows them before their scenes connect.
@MainActor
@Observable
final class WindowDirectory {
    static let shared = WindowDirectory()

    /// Every open pinned window, whichever ticket. A window counts from the moment it saves its
    /// value on its session (`remember`) until its scene disconnects or it's closed from here.
    private(set) var pinned: [TicketWindowValue] = []
    /// Sessions whose scene disconnected (closed, or let go by the system) or that were asked to
    /// close: not counted as open, though UIKit can list them a moment longer. One that connects
    /// again counts again.
    @ObservationIgnored private var gone: Set<String> = []
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIScene.didDisconnectNotification, object: nil, queue: .main) { note in
                // Posted on the main queue (`queue: .main`), by UIKit on the main thread.
                nonisolated(unsafe) let object = note.object
                MainActor.assumeIsolated {
                    guard let id = (object as? UIScene)?.session.persistentIdentifier else { return }
                    WindowDirectory.shared.gone.insert(id)
                    WindowDirectory.shared.refreshPinned()
                }
            },
            center.addObserver(forName: UIScene.willConnectNotification, object: nil, queue: .main) { note in
                // Posted on the main queue (`queue: .main`), by UIKit on the main thread.
                nonisolated(unsafe) let object = note.object
                MainActor.assumeIsolated {
                    guard let id = (object as? UIScene)?.session.persistentIdentifier else { return }
                    WindowDirectory.shared.gone.remove(id)
                    WindowDirectory.shared.refreshPinned()
                }
            },
        ]
        refreshPinned()
    }

    private struct Entry {
        weak var router: Router?
        weak var scene: UIWindowScene?

        /// The window is still open. A closed window's Router and scene can outlive it (SwiftUI and
        /// UIKit let go of them later), but its session is gone, and an activation request for a
        /// destroyed session does nothing: no window comes up and nothing opens in its place.
        var isOpen: Bool {
            guard router != nil, let scene, scene.activationState != .unattached else { return false }
            return UIApplication.shared.openSessions.contains(scene.session)
        }
    }

    @ObservationIgnored private var mains: [Entry] = []
    @ObservationIgnored private var tickets: [String: Entry] = [:]
    /// A section link that came from a ticket window while no main window was open: the next main
    /// window to come up applies it.
    @ObservationIgnored private var pending: DeepLink?

    /// A main window came up or became active (`scene` is nil until the view is in its window).
    /// Its ticket links open ticket windows from here on.
    func mainActive(_ router: Router, scene: UIWindowScene?) {
        let known = mains.first { $0.router === router }?.scene
        mains.removeAll { $0.router == nil || $0.router === router }
        mains.append(Entry(router: router, scene: scene ?? known))
        if router.onOpenTicket == nil {
            router.onOpenTicket = { [weak self, weak router] route in
                guard let self, let v = TicketWindowValue(route: route) else { return }
                self.openTicket(v, from: self.mains.first { $0.router === router }?.scene)
            }
        }
        if let link = pending {
            pending = nil
            router.open(link)
        }
    }

    /// Opens `link` in the last active main window and brings it forward, or opens a main window
    /// for it when none is open.
    func openInMain(_ link: DeepLink) {
        mains.removeAll { !$0.isOpen }
        if let main = mains.last, let router = main.router, let session = main.scene?.session {
            router.open(link)
            UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: session))
        } else {
            pending = link
            UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(role: .windowApplication))
        }
    }

    /// A tapped notification's link: opens in the last active main window (on iPad at regular
    /// width a ticket link opens the ticket's own window from there). On a cold launch from the
    /// tap no main window has come up yet, so the first one to come up applies it; unlike
    /// `openInMain`, that waits for the window the launch is already bringing up.
    func openFromNotification(_ link: DeepLink) {
        mains.removeAll { !$0.isOpen }
        if let router = mains.last?.router {
            router.open(link)
        } else {
            pending = link
        }
    }

    /// A ticket window is showing `key` (again, after its ticket changed).
    func ticketWindow(_ router: Router, scene: UIWindowScene?, key: String) {
        tickets = tickets.filter { $0.value.router != nil && $0.value.router !== router }
        tickets[key.uppercased()] = Entry(router: router, scene: scene)
    }

    /// Opens `value` in a window of its own: the system's prominent placement, centered over
    /// `from`, which the user can then move, resize, tile or put in Slide Over with the window's own
    /// controls. Windows are unique by `TicketWindowValue.identity`: each ticket gets one full
    /// window, and each torn-off tab one pinned window. One that's open comes forward instead (a
    /// full one on the link's tab). A closed window's entry is dropped here, so it opens anew rather
    /// than asking for the closed one back.
    func openTicket(_ value: TicketWindowValue, from scene: UIWindowScene?) {
        let options = UIWindowScene.ActivationRequestOptions()
        options.requestingScene = scene
        if !value.pinned {
            tickets = tickets.filter { $0.value.isOpen }
            if let target = tickets[value.key.uppercased()], let router = target.router, let session = target.scene?.session {
                router.show(value.route)
                UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: session, userActivity: nil, options: options))
                return
            }
        }
        if let session = session(for: value) {
            UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: session, userActivity: nil, options: options))
            return
        }
        options.placement = UIWindowSceneProminentPlacement.prominent()
        UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(role: .windowApplication, userActivity: Self.activity(value), options: options))
    }

    /// The activity that opens `value`'s window: what an activation request carries, and what a
    /// drag carries out of a window (TicketWindowDrag).
    nonisolated static func activity(_ value: TicketWindowValue) -> NSUserActivity {
        let activity = NSUserActivity(activityType: TicketWindowValue.activityType)
        activity.title = TornOffTabs.windowTitle(value)
        activity.targetContentIdentifier = TicketWindowValue.sceneMatch
        activity.userInfo = value.userInfo
        return activity
    }

    // MARK: Pinned windows

    /// Which of `key`'s tabs are torn off into pinned windows (observed: a view reading it updates
    /// as they open and close).
    func tornOff(_ key: String) -> TornOffTabs { TornOffTabs(pinned, key: key) }

    /// The open session showing `value`'s window (`identity`), other than `excluding`.
    func session(for value: TicketWindowValue, excluding: UISceneSession? = nil) -> UISceneSession? {
        UIApplication.shared.openSessions.first { s in
            s !== excluding && !gone.contains(s.persistentIdentifier) && TicketWindowValue(userInfo: s.userInfo)?.sameWindow(as: value) == true
        }
    }

    /// Closes `value`'s pinned window (Return to this window). It stops counting at once, so the
    /// tab is back here before the window has finished closing.
    func close(_ value: TicketWindowValue) {
        if let session = session(for: value) {
            gone.insert(session.persistentIdentifier)
            UIApplication.shared.requestSceneSessionDestruction(session, options: nil)
        }
        refreshPinned()
    }

    /// A pinned window's Return to ticket: closes it and brings the ticket's full window forward,
    /// when one is open, where the tab shows again.
    func returnToTicket(_ value: TicketWindowValue) {
        let full = session(for: TicketWindowValue(key: value.key, tab: nil))
        close(value)
        if let full { UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: full)) }
    }

    /// Re-reads the pinned windows from the open sessions' saved values.
    func refreshPinned() {
        let next = UIApplication.shared.openSessions
            .filter { !gone.contains($0.persistentIdentifier) }
            .compactMap { TicketWindowValue(userInfo: $0.userInfo) }
            .filter(\.pinned)
            .sorted { $0.identity < $1.identity }
        if next != pinned { pinned = next }
    }
}

/// Dragging a ticket, tab, browser tab or the composer out of its window (iPad): the item carries
/// the window's activity, so dropping it outside the window has iPadOS open that window.
enum TicketWindowDrag {
    static func provider(_ value: TicketWindowValue) -> NSItemProvider {
        let provider = NSItemProvider()
        provider.registerObject(WindowDirectory.activity(value), visibility: .all)
        provider.suggestedName = TornOffTabs.windowTitle(value)
        return provider
    }
}

/// Hands the view's UIWindowScene to `onScene` once the view is in a window (and again if it moves).
struct SceneReader: UIViewRepresentable {
    let onScene: (UIWindowScene) -> Void

    func makeUIView(context: Context) -> ReaderView {
        let v = ReaderView()
        v.onScene = onScene
        v.isUserInteractionEnabled = false
        return v
    }

    func updateUIView(_ uiView: ReaderView, context: Context) { uiView.onScene = onScene }

    final class ReaderView: UIView {
        var onScene: ((UIWindowScene) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let scene = window?.windowScene { onScene?(scene) }
        }
    }
}

/// A ticket window: one ticket's stack with its own Router, sheets and links. `value` is the
/// scene's saved ticket (nil when the window came from WindowDirectory.openTicket until its
/// activity arrives). A ticket the screen swaps for another (a remote ID's pick) becomes the saved one, so
/// a relaunch reopens it. A section link goes to the main window (WindowDirectory).
struct TicketWindowRoot: View {
    @Binding var value: TicketWindowValue?

    @Environment(AppModel.self) private var app
    @State private var router: Router?
    @State private var scene: UIWindowScene?
    @State private var waited = false

    var body: some View {
        Group {
            if let router {
                TicketWindowContent()
                    .environment(router)
                    .sceneChrome(router)
                    // Its ticket counts as on screen while the window is in the foreground.
                    .reportsPresence(router)
                    .onChange(of: router.root) { _, root in
                        guard var v = TicketWindowValue(route: root) else { return }
                        // A pinned window keeps its tab; only its ticket can change (a rename).
                        if let value, value.pinned {
                            v = value
                            v.key = TicketWindowValue(route: root)?.key ?? value.key
                        }
                        if v != value { value = v }
                    }
                    .onChange(of: router.closeRequested) { _, close in
                        if close, let session = scene?.session {
                            UIApplication.shared.requestSceneSessionDestruction(session, options: nil)
                        }
                    }
            } else {
                Group {
                    if waited {
                        EmptyState(icon: "alert", title: "No ticket", message: "This window didn't get a ticket to show.")
                    } else {
                        LoadingScreen()
                    }
                }
                .task {
                    try? await Task.sleep(for: .seconds(2))
                    waited = true
                }
            }
        }
        .background(SceneReader { s in
            scene = s
            if let value {
                remember(value, in: s)
                if let router, !value.pinned { WindowDirectory.shared.ticketWindow(router, scene: s, key: value.key) }
            } else if let v = TicketWindowValue(userInfo: s.session.userInfo) {
                value = v
            }
        })
        .onContinueUserActivity(TicketWindowValue.activityType) { activity in
            guard let v = TicketWindowValue(userInfo: activity.userInfo) else { return }
            // A drag out of a window opens a new one whatever is open (iPadOS spawns the scene
            // itself): when that window is already open, it comes forward and this one goes.
            if value == nil, let scene, let other = WindowDirectory.shared.session(for: v, excluding: scene.session) {
                UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: other))
                UIApplication.shared.requestSceneSessionDestruction(scene.session, options: nil)
                return
            }
            value = v
        }
        // Links from outside the app go to a main window (RootView prefers them).
        .handlesExternalEvents(preferring: [], allowing: ["\(DeepLink.scheme)://"])
        .onChange(of: value, initial: true) { _, v in
            guard let v else { return }
            remember(v, in: scene)
            if let router, TicketWindowValue(route: router.root)?.key == v.key {
                if router.root != v.route { router.show(v.route) }
            } else {
                let r = Router(ticket: v.route)
                r.onSectionLink = { WindowDirectory.shared.openInMain($0) }
                router = r
            }
            // Only full windows are what tapping a ticket brings forward.
            if let router, !v.pinned { WindowDirectory.shared.ticketWindow(router, scene: scene, key: v.key) }
        }
        .environment(\.pinnedWindow, value?.pinned == true ? value : nil)
    }
}

/// Titles the window and saves its ticket on the scene's session, which UIKit keeps across
/// launches. SwiftUI saves a WindowGroup's value only when openWindow gave it, so a window from
/// WindowDirectory.openTicket's activation request (value set from its activity) reads it back from
/// here on relaunch.
@MainActor
private func remember(_ value: TicketWindowValue, in scene: UIWindowScene?) {
    guard let scene else { return }
    scene.title = TornOffTabs.windowTitle(value)
    scene.session.userInfo = value.userInfo
    // A pinned window counts as open (its tab torn off) from here.
    WindowDirectory.shared.refreshPinned()
}

/// The ticket window's screen: its ticket (the Router's root) under its own stack, once connected.
/// A pinned window's root is only its one tab (TicketDetailScreen's pinned body); what it pushes
/// (a linked ticket, a file) shows in full as anywhere else.
private struct TicketWindowContent: View {
    @Environment(Router.self) private var router
    @Environment(\.pinnedWindow) private var pinned

    var body: some View {
        RequireStore {
            TabStack(tab: .board) {
                if let root = router.root {
                    if let pinned, case let .ticket(key, _) = root {
                        TicketDetailScreen(key: key, initialTab: pinned.tab, pinned: pinned).id(pinned)
                    } else {
                        RouteScreen(route: root).id(root)
                    }
                }
            }
        }
    }
}

extension EnvironmentValues {
    /// The pinned window this view is in (one torn-off tab), nil in a main or full ticket window.
    @Entry var pinnedWindow: TicketWindowValue?
}
