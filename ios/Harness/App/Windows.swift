import HarnessKit
import SwiftUI
import UIKit

// The iPad's windows (ARCHITECTURE.md § App shell, Windows): any number of main windows (RootView,
// each with its own Router) and ticket windows (TicketWindowRoot, keyed by TicketWindowValue).
// AppModel, the BoardStore, ToastCenter and Actions are shared by all of them. On iPad at regular
// width, opening a ticket shows it in the ticket viewer: one prominent window, reused from ticket to
// ticket. Open in New Window gives a ticket a window that stays on it.

/// The scene ids HarnessApp's WindowGroups use.
enum SceneID {
    static let ticket = "ticket"
}

/// The open windows: main windows, most recently active last, so a ticket window can send a
/// section link (harness://board, …) to one and bring it forward; ticket windows by key, so
/// tapping a ticket whose window is open brings that window forward instead of opening another;
/// and the viewer, the ticket window that taps reuse.
@MainActor
final class WindowDirectory {
    static let shared = WindowDirectory()

    private struct Entry {
        weak var router: Router?
        weak var scene: UIWindowScene?
    }

    private var mains: [Entry] = []
    private var tickets: [String: Entry] = [:]
    private var viewer: Entry?
    /// A section link that came from a ticket window while no main window was open: the next main
    /// window to come up applies it.
    private var pending: DeepLink?

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
        mains.removeAll { $0.router == nil }
        if let main = mains.last, let router = main.router {
            router.open(link)
            if let session = main.scene?.session {
                UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: session))
            }
        } else {
            pending = link
            UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(role: .windowApplication))
        }
    }

    /// A ticket window is showing `key` (again, after its ticket changed); `viewer` when it's the
    /// one taps reuse.
    func ticketWindow(_ router: Router, scene: UIWindowScene?, key: String, viewer isViewer: Bool) {
        tickets = tickets.filter { $0.value.router != nil && $0.value.router !== router }
        tickets[key.uppercased()] = Entry(router: router, scene: scene)
        if isViewer { viewer = Entry(router: router, scene: scene) }
    }

    /// Shows `value`'s ticket in the viewer: a window of its own in the system's prominent
    /// placement, centered over `from`, which the user can then move, resize, tile or put in Slide
    /// Over with the window's own controls. A window already showing the ticket comes forward
    /// instead, on the link's tab; otherwise an open viewer switches to the ticket and comes
    /// forward, so tapping one card after another doesn't pile up windows.
    func openTicket(_ value: TicketWindowValue, from scene: UIWindowScene?) {
        let target = tickets[value.key.uppercased()].flatMap { $0.router == nil ? nil : $0 } ?? viewer
        if let target, let router = target.router, let session = target.scene?.session {
            router.show(value.route)
            let options = UIWindowScene.ActivationRequestOptions()
            options.requestingScene = scene
            UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: session, userActivity: nil, options: options))
            return
        }
        let activity = NSUserActivity(activityType: TicketWindowValue.activityType)
        activity.title = value.key
        activity.targetContentIdentifier = TicketWindowValue.sceneMatch
        activity.userInfo = value.userInfo
        let options = UIWindowScene.ActivationRequestOptions()
        options.placement = UIWindowSceneProminentPlacement.prominent()
        options.requestingScene = scene
        UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(role: .windowApplication, userActivity: activity, options: options))
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
    /// The viewer that ticket taps reuse (it came from WindowDirectory.openTicket's activity), not a
    /// window from Open in New Window.
    @State private var isViewer = false

    var body: some View {
        Group {
            if let router {
                TicketWindowContent()
                    .environment(router)
                    .sceneChrome(router)
                    .onChange(of: router.root) { _, root in
                        if let v = TicketWindowValue(route: root), v != value { value = v }
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
                remember(value, viewer: isViewer, in: s)
                if let router { WindowDirectory.shared.ticketWindow(router, scene: s, key: value.key, viewer: isViewer) }
            } else if let v = TicketWindowValue(userInfo: s.session.userInfo) {
                isViewer = s.session.userInfo?[viewerKey] as? Bool == true
                value = v
            }
        })
        .onContinueUserActivity(TicketWindowValue.activityType) { activity in
            if let v = TicketWindowValue(userInfo: activity.userInfo) {
                isViewer = true
                value = v
            }
        }
        // Links from outside the app go to a main window (RootView prefers them).
        .handlesExternalEvents(preferring: [], allowing: ["\(DeepLink.scheme)://"])
        .onChange(of: value, initial: true) { _, v in
            guard let v else { return }
            remember(v, viewer: isViewer, in: scene)
            if let router, TicketWindowValue(route: router.root)?.key == v.key {
                if router.root != v.route { router.show(v.route) }
            } else {
                let r = Router(ticket: v.route)
                r.onSectionLink = { WindowDirectory.shared.openInMain($0) }
                router = r
            }
            if let router { WindowDirectory.shared.ticketWindow(router, scene: scene, key: v.key, viewer: isViewer) }
        }
    }
}

/// Titles the window and saves its ticket on the scene's session, which UIKit keeps across
/// launches. SwiftUI saves a WindowGroup's value only when openWindow gave it, so a window from
/// WindowDirectory.openTicket's activation request (value set from its activity) reads it back from
/// here on relaunch, along with whether it's the viewer.
@MainActor
private func remember(_ value: TicketWindowValue, viewer: Bool, in scene: UIWindowScene?) {
    guard let scene else { return }
    scene.title = value.key
    var info: [String: Any] = value.userInfo
    info[viewerKey] = viewer
    scene.session.userInfo = info
}

private let viewerKey = "viewer"

/// The ticket window's screen: its ticket (the Router's root) under its own stack, once connected.
private struct TicketWindowContent: View {
    @Environment(Router.self) private var router

    var body: some View {
        RequireStore {
            TabStack(tab: .board) {
                if let root = router.root { RouteScreen(route: root).id(root) }
            }
        }
    }
}
