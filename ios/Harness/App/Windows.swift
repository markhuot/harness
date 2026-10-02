import HarnessKit
import SwiftUI
import UIKit

// The iPad's windows (ARCHITECTURE.md § App shell, Windows): any number of main windows (RootView,
// each with its own Router) and ticket windows (TicketWindowRoot, keyed by TicketWindowValue).
// AppModel, the BoardStore, ToastCenter and Actions are shared by all of them. On iPad at regular
// width, opening a ticket opens (or brings forward) its window.

/// The scene ids HarnessApp's WindowGroups use.
enum SceneID {
    static let ticket = "ticket"
}

/// The open windows: main windows, most recently active last, so a ticket window can send a
/// section link (harness://board, …) to one and bring it forward; and ticket windows by key, so
/// tapping a ticket whose window is open brings that window forward instead of opening another.
@MainActor
final class WindowDirectory {
    static let shared = WindowDirectory()

    private struct Entry {
        weak var router: Router?
        weak var scene: UIWindowScene?
    }

    private var mains: [Entry] = []
    private var tickets: [String: Entry] = [:]
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

    /// A ticket window is showing `key` (again, after its ticket changed).
    func ticketWindow(_ router: Router, scene: UIWindowScene?, key: String) {
        tickets = tickets.filter { $0.value.router != nil && $0.value.router !== router }
        tickets[key.uppercased()] = Entry(router: router, scene: scene)
    }

    /// Opens `value`'s ticket in a window of its own: the system's prominent placement, centered
    /// over `from`, which the user can then move, resize, tile or put in Slide Over with the
    /// window's own controls. A window already showing the ticket comes forward instead, on the
    /// link's tab.
    func openTicket(_ value: TicketWindowValue, from scene: UIWindowScene?) {
        if let open = tickets[value.key.uppercased()], let router = open.router, let session = open.scene?.session {
            router.show(value.route)
            UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: session))
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
                remember(value, in: s)
                if let router { WindowDirectory.shared.ticketWindow(router, scene: s, key: value.key) }
            } else if let v = TicketWindowValue(userInfo: s.session.userInfo) {
                value = v
            }
        })
        .onContinueUserActivity(TicketWindowValue.activityType) { activity in
            if let v = TicketWindowValue(userInfo: activity.userInfo) { value = v }
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
            if let router { WindowDirectory.shared.ticketWindow(router, scene: scene, key: v.key) }
        }
    }
}

/// Titles the window and saves its ticket on the scene's session, which UIKit keeps across
/// launches. SwiftUI saves a WindowGroup's value only when openWindow gave it, so a window from
/// WindowDirectory.openTicket's activation request (value set from its activity) reads it back from
/// here on relaunch.
@MainActor
private func remember(_ value: TicketWindowValue, in scene: UIWindowScene?) {
    guard let scene else { return }
    scene.title = value.key
    scene.session.userInfo = value.userInfo
}

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
