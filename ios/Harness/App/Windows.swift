import HarnessKit
import SwiftUI
import UIKit

// The iPad's windows (ARCHITECTURE.md § App shell, Windows): any number of main windows (RootView,
// each with its own Router) and ticket windows (TicketWindowRoot, keyed by TicketWindowValue).
// AppModel, the BoardStore, ToastCenter and Actions are shared by all of them.

/// The scene ids HarnessApp's WindowGroups use.
enum SceneID {
    static let ticket = "ticket"
}

/// The main windows, most recently active last, so a ticket window can send a section link
/// (harness://board, …) to one and bring it forward, and a ticket window that opens can close the
/// panel it was dragged out of.
@MainActor
final class WindowDirectory {
    static let shared = WindowDirectory()

    private struct Main {
        weak var router: Router?
        weak var scene: UIWindowScene?
    }

    private var mains: [Main] = []
    /// A section link that came from a ticket window while no main window was open: the next main
    /// window to come up applies it.
    private var pending: DeepLink?

    /// A main window came up or became active.
    func mainActive(_ router: Router, scene: UIWindowScene?) {
        mains.removeAll { $0.router == nil || $0.router === router }
        mains.append(Main(router: router, scene: scene))
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

    /// A ticket window opened on `value`: a panel showing that ticket was dragged out to make it,
    /// so it closes.
    func ticketWindowOpened(_ value: TicketWindowValue) {
        for main in mains {
            guard let router = main.router, let top = TicketWindowValue(route: router.panel?.topTicket) else { continue }
            if top.key == value.key { router.closePanel() }
        }
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

/// The NSItemProvider a dragged-out panel carries: an NSUserActivity for the ticket, which iPadOS
/// turns into a new window when it's dropped at the screen's edge (TicketWindowValue).
@MainActor
func ticketWindowItemProvider(_ value: TicketWindowValue, title: String) -> NSItemProvider {
    let activity = NSUserActivity(activityType: TicketWindowValue.activityType)
    activity.title = title
    activity.targetContentIdentifier = TicketWindowValue.sceneMatch
    activity.userInfo = value.userInfo
    let provider = NSItemProvider()
    provider.registerObject(activity, visibility: .all)
    provider.suggestedName = title
    return provider
}

/// A ticket window: one ticket's stack with its own Router, sheets and links. `value` is the
/// scene's saved ticket (nil when the window came from a dragged-out panel until its activity
/// arrives). A ticket the screen swaps for another (a remote ID's pick) becomes the saved one, so
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
            if let value { s.title = value.key }
        })
        .onContinueUserActivity(TicketWindowValue.activityType) { activity in
            if let v = TicketWindowValue(userInfo: activity.userInfo) { value = v }
        }
        // Links from outside the app go to a main window (RootView prefers them).
        .handlesExternalEvents(preferring: [], allowing: ["\(DeepLink.scheme)://"])
        .onChange(of: value, initial: true) { _, v in
            guard let v else { return }
            scene?.title = v.key
            WindowDirectory.shared.ticketWindowOpened(v)
            if router?.root == v.route { return }
            let r = Router(ticket: v.route)
            r.onSectionLink = { WindowDirectory.shared.openInMain($0) }
            router = r
        }
    }
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
