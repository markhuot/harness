import HarnessKit
import SwiftUI
import UIKit

/// Where the dock window takes touches, in window coordinates: the collapsed stack's rect, or the whole
/// screen while the list is open. Everything else falls through to the board or the ticket sheet
/// below it. Read by `DockWindow.hitTest`, so it is plain state rather than observed.
@MainActor final class DockHitRegion {
    var rects: [CGRect] = []
    /// The list is open: it and its backdrop take every touch.
    var fullScreen = false
    /// False while the dock is faded out (a keyboard, a picker, a dialog): nothing to touch.
    var enabled = true

    func contains(_ point: CGPoint) -> Bool {
        guard enabled else { return false }
        return fullScreen || rects.contains { $0.contains(point) }
    }
}

/// The window the phone's dock lives in: above the main window and whatever it presents (the ticket
/// sheet, pickers), so one dock stays mounted while the board and the sheet come and go under it. It
/// takes touches only on the cards; it never becomes the key window, so it neither steals the first
/// responder from the composer nor the hidden shortcuts.
final class DockWindow: UIWindow {
    let hit = DockHitRegion()

    override var canBecomeKey: Bool { false }
    override var canBecomeFirstResponder: Bool { false }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // Hit-tested by the published frames, not "nil if the hit view is the root": SwiftUI's own
        // gesture views make that unreliable on iOS 18 and later.
        guard hit.contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// The dock window's root: the status bar and orientations are those of whatever is on top in the
/// main window (a cover, the ticket sheet), so adding the window changes neither.
final class DockHostController: UIHostingController<DockWindowRoot> {
    var mainRoot: () -> UIViewController? = { nil }

    override var preferredStatusBarStyle: UIStatusBarStyle { mainRoot()?.preferredStatusBarStyle ?? .default }
    override var prefersStatusBarHidden: Bool { mainRoot()?.prefersStatusBarHidden ?? false }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { mainRoot()?.supportedInterfaceOrientations ?? .all }
}

/// What hides the dock for a moment: a keyboard, or a dialog or picker the main window presented.
@MainActor @Observable final class DockWindowState {
    var keyboardUp = false
    var dialogUp = false
}

/// One dock window per main window scene at compact width (the iPhone, and a narrow iPad window):
/// none for a ticket window, and none at regular width, where the iPad's panel host draws its own
/// stack over the board (TicketPanelHost). RootView creates and tears it down as its scene and size
/// class change.
@MainActor final class DockWindowController {
    private var window: DockWindow?
    private var disconnect: NSObjectProtocol?
    /// The scene's own window, found when the dock is shown: the first window that isn't the dock's
    /// (not a system one such as the text-effects window).
    private weak var mainWindow: UIWindow?
    private weak var scene: UIWindowScene?
    private var lastDepth = 0
    private weak var host: DockHostController?

    /// Shows the dock in `scene` (once; a second call for the same scene changes nothing).
    func show(in scene: UIWindowScene, root: @escaping (DockHitRegion, DockWindowState, @escaping (Int) -> Bool) -> DockWindowRoot) {
        if let window, window.windowScene === scene { return }
        tearDown()
        mainWindow = Self.mainWindow(in: scene)
        self.scene = scene
        let window = DockWindow(windowScene: scene)
        window.windowLevel = .normal + 1
        window.backgroundColor = .clear
        let state = DockWindowState()
        let probe: (Int) -> Bool = { [weak self] expected in
            guard let self else { return false }
            let depth = self.presentedChain.count
            if depth != self.lastDepth {
                // What's on top changed: so may the status bar style and orientations the dock host forwards.
                self.lastDepth = depth
                self.host?.setNeedsStatusBarAppearanceUpdate()
            }
            return DockCards.dialogUp(presentedDepth: depth, expected: expected)
        }
        let host = DockHostController(rootView: root(window.hit, state, probe))
        self.host = host
        host.view.backgroundColor = .clear
        host.mainRoot = { [weak self] in
            guard let self else { return nil }
            return self.presentedChain.last ?? self.mainWindow?.rootViewController
        }
        window.rootViewController = host
        window.isHidden = false
        self.window = window
        disconnect = NotificationCenter.default.addObserver(forName: UIScene.didDisconnectNotification, object: scene, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tearDown() }
        }
    }

    private static func mainWindow(in scene: UIWindowScene) -> UIWindow? {
        scene.windows.first { !($0 is DockWindow) && $0.isKeyWindow } ?? scene.windows.first { !($0 is DockWindow) }
    }

    func tearDown() {
        if let disconnect { NotificationCenter.default.removeObserver(disconnect) }
        disconnect = nil
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
    }

    /// What the main window has presented, bottom to top, leaving out what is on its way out: the
    /// ticket sheet, then anything on top of it (alerts, the share sheet, pickers, and the SwiftUI
    /// sheets, popovers and covers the screens open themselves).
    private var presentedChain: [UIViewController] {
        var chain: [UIViewController] = []
        // The scene may not have had its window yet when the dock was shown.
        if mainWindow == nil, let scene { mainWindow = Self.mainWindow(in: scene) }
        var top = mainWindow?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed {
            chain.append(next)
            top = next
        }
        return chain
    }
}

/// The root of the dock window: the dock with the environment the main window gives its views.
struct DockWindowRoot: View {
    let router: Router
    let app: AppModel
    let hold: DockHold
    let inset: DockedSheetInset
    let hit: DockHitRegion
    let state: DockWindowState
    /// Whether something is presented over the ticket, given how many presentations the dock expects.
    let dialogProbe: (Int) -> Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = Palette(app.resolvedTheme(systemDark: scheme == .dark))
        PhoneDock(hit: hit, state: state, dialogProbe: dialogProbe)
            .modifier(ConcentricScreenReader())
            .environment(router)
            .environment(app)
            .environment(hold)
            .environment(inset)
            .environment(\.palette, palette)
            .tint(palette.accent)
            .preferredColorScheme(app.prefs.theme == .system ? nil : app.prefs.theme == .dark ? .dark : .light)
    }
}

/// The phone's dock: every waiting ticket as a card at the bottom of the screen, over the board and
/// the open ticket alike, and what it tells the rest of the app: where its stack is
/// (`DockedSheetInset.stackTop`, for the board's bar, the sections and the composer to sit above) and
/// where it takes touches. It fades out while a keyboard, a cover, a picker or a dialog is up, which
/// the composer and the board's bar know through the zero clearance.
private struct PhoneDock: View {
    let hit: DockHitRegion
    let state: DockWindowState
    let dialogProbe: (Int) -> Bool
    @Environment(Router.self) private var router
    @Environment(DockedSheetInset.self) private var inset
    @Environment(DockHold.self) private var hold
    @Environment(\.concentricScreen) private var screen
    /// The app is in front: the dock window's own scenePhase isn't reliable, so it follows the app.
    @State private var active = UIApplication.shared.applicationState != .background

    private var shown: Bool {
        DockCards.isShown(count: router.waitingSheets.count, ghost: hold.armed, sheetUp: router.sheet != nil, coverUp: router.cover != nil,
                          keyboardUp: state.keyboardUp, dialogUp: state.dialogUp)
    }

    var body: some View {
        let shown = shown
        GeometryReader { geo in
            DockedCardsContainer(sheets: router.waitingSheets, layout: .phone(screen: screen, region: geo.size,
                                                        lift: DockMetrics.lift(barInset: inset.barInset, homeIndicator: screen?.homeIndicator ?? 0)),
                                 ghost: hold.armed ? router.ticketSheet?.title : nil,
                                 docked: router.ticketSheetState == .docked, shown: shown, onReport: report)
                .frame(width: geo.size.width, height: geo.size.height, alignment: .bottom)
        }
        .ignoresSafeArea(.keyboard)
        .opacity(shown ? 1 : 0)
        .animation(.easeOut(duration: 0.15), value: shown)
        .accessibilityHidden(!shown)
        .onChange(of: shown, initial: true) { _, shown in hit.enabled = shown }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { note in
            // The software keyboard on this screen: not the hardware keyboard's shortcut bar, which is short.
            let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .zero
            setKeyboard(frame.height > 100)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in setKeyboard(false) }
        .onDisappear { setKeyboard(false) }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in active = true }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in active = false }
        // A presentation the Router doesn't know about, looked for while there are cards to hide and the
        // app is in front. The ticket sheet is the one presentation the dock expects.
        .task(id: !router.waitingSheets.isEmpty && active) {
            guard !router.waitingSheets.isEmpty, active else { state.dialogUp = false; return }
            while !Task.isCancelled {
                var up = dialogProbe(router.ticketSheet != nil ? 1 : 0)
                // A ticket sheet that was just docked or closed is still presented for a beat after the
                // router lets go of it: look again before treating it as someone else's.
                if up, !state.dialogUp {
                    try? await Task.sleep(for: .milliseconds(120))
                    up = dialogProbe(router.ticketSheet != nil ? 1 : 0)
                }
                if up != state.dialogUp { state.dialogUp = up }
                try? await Task.sleep(for: .milliseconds(150))
            }
        }
    }

    private func setKeyboard(_ up: Bool) {
        state.keyboardUp = up
        inset.keyboardUp = up
    }

    private func report(_ report: DockedCardsReport) {
        inset.stackTop = report.stack?.minY
        hit.fullScreen = report.expanded
        hit.rects = report.stack.map { [$0.insetBy(dx: -8, dy: -8)] } ?? []
    }
}
