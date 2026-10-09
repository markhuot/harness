import HarnessKit
import SwiftUI

/// The ticket sheets (`Router.dockedSheets`, the top `Router.ticketSheet` / `Router.dock`) at compact
/// width (iPhone, and a narrow iPad window; regular width is TicketPanelHost): one system sheet with
/// two detents, whatever the number of tickets. At `.large` it's TicketSheetContent, the top ticket
/// (or New session) in its own NavigationStack, so a child, dep or parent pushes inside the sheet
/// and Back returns. Every live sheet (`Router.liveSheets`) keeps its stack mounted behind the top
/// one, hidden, so switching swaps the content in place (no re-present) and keeps drafts, scroll and
/// path; a parked one mounts again at its saved path when it comes back. Dragged down to the dock
/// detent it docks, like Mail's minimized draft: the stacks stay mounted but hidden, and the small
/// sheet is the top ticket's minimized card (TicketDock) under the board, which stays usable
/// (`presentationBackgroundInteraction`). The other docked tickets' cards and "N more…" stack above
/// it in the main window (DockedCardsAbove), as glass capsules like the sheet. Tapping a card, or
/// dragging the sheet up, brings a ticket back. Swiping the sheet down closes the top ticket, and so does a flick down from `.large`
/// (SheetFlick); the next one comes back docked (RootView re-presents the sheet). The system does the drags, the inset and the corners, so the content's own
/// gestures (the pager, the back swipe, the Browser tab, the transcript) keep theirs; the board's
/// bottom bar takes the docked sheet's side inset (DockedSheetInset) so the two line up.
///
/// Pickers, the watcher form and covers come up over it: the root is busy presenting this, so
/// they're presented from here. Projects closes it instead (`Router.open(.sheet(.projects))`), and
/// anything the board behind presents (an alert in Settings, say) has UIKit dismiss it, which the
/// root's binding turns into `dismissSheet()`. New session drafts are saved either way.
struct TicketSheetHost: View {
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    /// The sheet as it was last up, so its content stays while it animates away.
    @State private var last: TicketSheet?
    /// Whether it was docked when last up, for the detent while it animates away.
    @State private var lastDocked = false
    @Environment(DockedSheetInset.self) private var dockInset
    /// How the last drag on the sheet let go, for a flick that should send it away.
    @State private var flick = SheetFlick()

    var body: some View {
        let current = router.ticketSheet ?? router.dock
        let sheet = current ?? last
        // Gone, the last one stays mounted while the sheet animates away.
        let mounted = current == nil ? (last.map { [$0] } ?? []) : router.liveSheets
        GeometryReader { geo in
            // By height rather than state, so the card takes over as the sheet settles at the dock.
            let docked = geo.size.height < TicketDock.height + 60
            ZStack(alignment: .top) {
                ForEach(mounted) { s in
                    let isTop = s.id == sheet?.id
                    let shown = isTop && !docked
                    stack(s)
                        .opacity(shown ? 1 : 0)
                        .allowsHitTesting(shown)
                        .accessibilityHidden(!shown)
                        // Behind the top: no key commands (New session's Escape) either.
                        .disabled(!isTop)
                        .zIndex(isTop ? 1 : 0)
                }
                if docked, let sheet {
                    TicketDock(sheet: sheet)
                        .frame(height: geo.size.height)
                        .zIndex(2)
                }
            }
            // Behind the keyboard too, so its rounded corners show the sheet's background, not the
            // system sheet's. Docked, the sheet keeps the system's glass: it is the top card.
            .background { if !docked { c.bg.ignoresSafeArea() } }
            .onChange(of: docked) { _, docked in
                // A docked New session mustn't keep the keyboard up over the board.
                if docked { resignFirstResponder() }
            }
            // Where the system floats the docked sheet, for the sections and the board's bar. Only
            // where it rests: a sheet under a finger (from `.large`, or the dock dragged up or
            // away) would move the board's bar and clearance with it every frame. Let go, the
            // system lays it out where it's headed.
            .onGeometryChange(for: CGRect?.self) { g in docked ? g.frame(in: .global) : nil } action: { f in
                guard let f, !flick.isDragging else { return }
                dockInset.sides = f.minX
                dockInset.top = f.minY
            }
        }
        .background {
            SheetFlickTracker(flick: flick, swipes: router.ticketSheetState == .docked && router.dockedSheets.count > 1) {
                TicketDock.step(router, $0)
            }
        }
        .onChange(of: current, initial: true) { _, s in if let s { last = s } }
        // Switching tickets mustn't leave the keyboard up for the one now hidden.
        .onChange(of: current?.id) { resignFirstResponder() }
        .onChange(of: router.ticketSheetState, initial: true) { _, s in if s != .gone { lastDocked = s == .docked } }
        .presentationDetents([TicketDock.detent, .large], selection: detent)
        .presentationBackgroundInteraction(.enabled(upThrough: TicketDock.detent))
        .presentationDragIndicator(.visible)
        .sheet(item: Binding(get: { router.sheet }, set: { router.sheet = $0 })) { sheet in
            SheetHost(sheet: sheet)
                .fullScreenCover(item: coverBinding(whenSheet: true)) { CoverHost(cover: $0) }
        }
        .fullScreenCover(item: coverBinding(whenSheet: false)) { CoverHost(cover: $0) }
    }

    private func stack(_ sheet: TicketSheet) -> some View {
        TicketSheetContent(sheet: sheet, toBottomEdge: true)
            // The sheet runs to the screen's bottom edge without keeping the home indicator's
            // inset, so the composer measures its concentric gap from the edge itself.
            .environment(\.concentricBottomGap, 0)
    }

    /// Gone, the sheet keeps the detent it had, so the dock's ✕ sends it away from the dock
    /// rather than growing it to `.large` on the way out.
    ///
    /// The system only ever settles a drag from `.large` on the dock, however hard it was flung, so
    /// a drag that let go moving down fast (SheetFlick) sends the sheet away instead; one that
    /// slowed or lingered near the bottom docks. It's decided once the drag's end has been seen,
    /// whichever recognizer UIKit told first, and a flung sheet goes straight from presented to
    /// gone: never docked for a frame, which would have the board make room for the dock and give
    /// it back mid-swipe. Going away, it keeps the dock detent it settled on.
    private var detent: Binding<PresentationDetent> {
        Binding(get: {
                    switch router.ticketSheetState {
                    case .gone: lastDocked ? TicketDock.detent : .large
                    case .docked: TicketDock.detent
                    case .presented: .large
                    }
                },
                set: { new in
                    guard new == TicketDock.detent else { return router.restoreDock() }
                    guard router.ticketSheetState == .presented else { return router.dockSheet() }
                    flick.settled(at: Date()) { outcome in
                        guard router.ticketSheetState == .presented else { return }
                        switch outcome {
                        case .dock: router.dockSheet()
                        case .dismiss:
                            lastDocked = true
                            router.dismissSheet()
                        }
                    }
                    // A release that never comes (a recognizer UIKit never told) docks a turn later.
                    DispatchQueue.main.async { flick.flush() }
                })
    }

    /// The cover is presented by whichever level is on top: a sheet over this one, else this.
    private func coverBinding(whenSheet: Bool) -> Binding<CoverRoute?> {
        Binding(get: { (router.sheet != nil) == whenSheet ? router.cover : nil }, set: { router.cover = $0 })
    }
}

/// Drops the keyboard, wherever it is.
@MainActor func resignFirstResponder() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

/// A ticket sheet's content, the same in the iPhone's sheet (TicketSheetHost) and the iPad's side
/// panel (TicketPanelHost): the ticket (or New session) in its own NavigationStack, bound to that
/// sheet's path, so a child, dep or parent pushes inside it and Back returns. Each screen's toolbar
/// carries the docked tickets' switcher while there's more than one.
struct TicketSheetContent: View {
    let sheet: TicketSheet
    /// The iPhone's sheet: each screen runs to the screen's bottom edge, keeping no inset there but
    /// the keyboard's. Docked, the system gives the small floating sheet the home indicator's inset
    /// and keeps it once the sheet is back at `.large`, which would lift the composer by that much;
    /// it has to be ignored inside the stack, since the stack's screens take their safe area from it.
    var toBottomEdge = false
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    /// The store wraps the whole stack: pushed screens take their environment from the stack.
    var body: some View {
        RequireStore {
            NavigationStack(path: Binding(get: { router.dockedSheets.first { $0.id == sheet.id }?.path ?? sheet.path },
                                          set: { router.setTicketSheetPath($0, id: sheet.id) })) {
                screen(root
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(c.bg))
                    .navigationDestination(for: Route.self) { screen(RouteScreen(route: $0)) }
            }
        }
        .environment(\.inTicketSheet, true)
        // New session that became its ticket starts over as the ticket's screen.
        .id(sheet.root)
    }

    private func screen(_ screen: some View) -> some View { bottomEdge(screen) }

    @ViewBuilder private func bottomEdge(_ screen: some View) -> some View {
        if toBottomEdge { screen.ignoresSafeArea(.container, edges: .bottom) } else { screen }
    }

    @ViewBuilder private var root: some View {
        switch sheet.root {
        case let .ticket(key, tab): RouteScreen(route: .ticket(key: key, tab: tab))
        case let .newSession(projectId, key): NewSessionScreen(projectId: projectId, key: key)
        }
    }
}

extension EnvironmentValues {
    /// Inside the ticket sheet's stack (TicketSheetContent), at either width: a link there is a
    /// step within the sheet rather than a new choice from outside it (`Router.openTicket`).
    @Entry var inTicketSheet = false
    /// Inside the iPad's ticket panel (TicketPanelHost), whose buttons float over the top trailing
    /// corner and whose root ticket has no navigation bar (TicketDetailHeader).
    @Entry var inTicketPanel = false
    /// How far the panel's buttons reach in from the trailing edge: the root ticket's hero title
    /// wraps before them. 0 outside the panel.
    @Entry var ticketPanelTitleInset: CGFloat = 0
}

/// Where the system floats the docked ticket sheet, as last measured docked: how far from the
/// screen's sides, and its top edge in the window. The sheet is presented, so this reaches the
/// sections (DockClearance) and the board's bottom bar through the environment (RootView) rather
/// than a preference; the bar lines up with the dock while `Router.showsDock`.
@Observable final class DockedSheetInset {
    var sides: CGFloat?
    var top: CGFloat?
    /// The iPad: how much of the board's bottom the docked card stack takes (DockedCardStack); 0
    /// without one.
    var cards: CGFloat = 0
    /// The iPad: where the board's column starts in the window, right of the sidebar, so the docked
    /// card stack keeps off the sidebar (DesktopShell measures it).
    var contentLeading: CGFloat = 0
}

/// Watches drags on the ticket sheet alongside the system's own, without taking any touches: a pan
/// on the sheet's container view (which holds the grabber too) that recognizes with everything.
/// Touches that pass through to the board behind never reach it.
private struct SheetFlickTracker: UIViewRepresentable {
    let flick: SheetFlick
    /// Docked with more than one ticket: a horizontal swipe on the sheet switches tickets.
    var swipes = false
    var onSwipe: (Router.DockStep) -> Void = { _ in }

    func makeUIView(context: Context) -> Probe { Probe(flick: flick) }
    func updateUIView(_ view: Probe, context: Context) {
        view.onSwipe = onSwipe
        view.swipesEnabled = swipes
    }

    final class Probe: UIView, UIGestureRecognizerDelegate {
        let flick: SheetFlick
        var onSwipe: (Router.DockStep) -> Void = { _ in }
        var swipesEnabled = false {
            didSet { [left, right].forEach { $0.isEnabled = swipesEnabled } }
        }
        /// The dock's swipes, on the sheet's container like the pan: a SwiftUI gesture on the
        /// cards kept the system sheet's own pan from taking a swipe down.
        private lazy var left = swipe(.left)
        private lazy var right = swipe(.right)

        private func swipe(_ direction: UISwipeGestureRecognizer.Direction) -> UISwipeGestureRecognizer {
            let swipe = UISwipeGestureRecognizer(target: self, action: #selector(swiped))
            swipe.direction = direction
            swipe.cancelsTouchesInView = false
            swipe.delaysTouchesBegan = false
            swipe.delaysTouchesEnded = false
            swipe.delegate = self
            swipe.isEnabled = swipesEnabled
            return swipe
        }

        @objc private func swiped(_ swipe: UISwipeGestureRecognizer) {
            onSwipe(swipe.direction == .left ? .next : .previous)
        }
        private lazy var pan: UIPanGestureRecognizer = {
            let pan = UIPanGestureRecognizer(target: self, action: #selector(panned))
            pan.cancelsTouchesInView = false
            pan.delaysTouchesBegan = false
            pan.delaysTouchesEnded = false
            pan.delegate = self
            return pan
        }()

        init(flick: SheetFlick) {
            self.flick = flick
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) { fatalError() }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            for g in [pan, left, right] { g.view?.removeGestureRecognizer(g) }
            guard window != nil, let container = presentedController?.presentationController?.containerView else { return }
            for g in [pan, left, right] { container.addGestureRecognizer(g) }
        }

        /// The view controller the sheet presents: the outermost one above this view.
        private var presentedController: UIViewController? {
            var responder: UIResponder? = self
            var found: UIViewController?
            while let r = responder {
                if let vc = r as? UIViewController {
                    found = vc
                    if vc.parent == nil { break }
                }
                responder = r.next
            }
            return found?.presentingViewController == nil ? nil : found
        }

        @objc private func panned(_ pan: UIPanGestureRecognizer) {
            switch pan.state {
            case .began: flick.began()
            case .ended: flick.ended(velocity: pan.velocity(in: pan.view).y, at: Date())
            case .cancelled, .failed: flick.cancelled()
            default: break
            }
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

/// Keeps a section's screen clear of the docked ticket sheet. It goes inside the section's
/// NavigationStack, on each screen: a safe-area inset outside the stack doesn't reach the board's
/// own bottom bar. Not while a keyboard is up: the dock is behind it. In the iPad's DesktopShell,
/// room for the docked tickets' card stack in the bottom-right corner instead
/// (`DockedSheetInset.cards`), so the last cards scroll clear of it.
private struct DockClearance: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(\.concentricScreen) private var screen
    @Environment(\.desktopShell) private var desktop
    @Environment(DockedSheetInset.self) private var dockInset: DockedSheetInset?
    @State private var keyboard = false

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if desktop, let cards = dockInset?.cards, cards > 0 {
                    Color.clear.frame(height: cards)
                } else if router.showsDock && !desktop && !keyboard {
                    // The docked sheet, and the cards stacked above it.
                    Color.clear.frame(height: TicketDock.clearance(screen: screen, dockTop: dockInset?.top)
                        + DockedCardsAbove.height(count: router.dockedSheets.count))
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
    }
}

extension View {
    func dockClearance() -> some View { modifier(DockClearance()) }
}

/// The docked ticket sheet's content: the top ticket's minimized card (DockedCard, on the sheet's own
/// glass), as the single dock always was; the other docked tickets stack above it in the main
/// window (DockedCardsAbove). A tap opens it, its ✕ closes just it, and a swipe along the dock moves
/// to the next or previous ticket, like Safari's tab bar (SheetFlickTracker).
struct TicketDock: View {
    let sheet: TicketSheet
    @Environment(Router.self) private var router

    /// The sheet's height while docked: one card's.
    static let height = DockedCardMetrics.height
    static let detent = PresentationDetent.height(height)
    /// How far the board's bottom bar sits above the docked cards, the same on every phone.
    static let barGap: CGFloat = 11

    /// What a section gives up at its bottom while a sheet is docked, so the dock sits under the
    /// board's bottom bar rather than over it: everything below the docked sheet's top edge, less
    /// the home indicator's inset the section already keeps clear. The bar keeps `barGap` above
    /// that (BoardScreen). Before the dock is measured, the sheet plus a guess at the float and gap.
    static func clearance(screen: ConcentricBar.Screen?, dockTop: CGFloat?) -> CGFloat {
        let homeIndicator = screen?.homeIndicator ?? 0
        guard let screen, let dockTop else { return max(0, height + 27 - homeIndicator) }
        return max(0, screen.height - dockTop - homeIndicator)
    }

    var body: some View {
        DockedCard(sheet: sheet, glass: false, open: { router.restoreDock() }, close: { router.dismissSheet() })
            .frame(maxHeight: .infinity, alignment: .top)
            .accessibilityAction(named: "Next docked ticket") { TicketDock.step(router, .next) }
            .accessibilityAction(named: "Previous docked ticket") { TicketDock.step(router, .previous) }
    }

    /// The next or previous docked ticket on top: a swipe along the dock (SheetFlickTracker) or
    /// VoiceOver's actions.
    static func step(_ router: Router, _ step: Router.DockStep) {
        guard router.dockedSheets.count > 1 else { return }
        withAnimation(.snappy) { router.activateAdjacentSheet(step) }
    }
}

/// The iPhone's other docked tickets, above the docked sheet (which is the top one's card): their
/// cards, glass capsules as wide as the sheet and 8pt above it, the most recent nearest it, up to
/// `DockCards.phoneVisible` cards in all with the sheet's, then "N more…" on top. "N more…" expands
/// every one but the top into a scrolling list over the board, on a DockedBackdrop rising out of
/// the bottom; the sheet's card stays where it is under it. Lives in the main window, laid out from
/// where the docked sheet floats (DockedSheetInset).
struct DockedCardsAbove: View {
    @Environment(Router.self) private var router
    @Environment(DockedSheetInset.self) private var dockInset
    @State private var expanded = false

    /// The rows above the sheet for `count` docked tickets, with their gaps: what the sections
    /// give up on top of the sheet's clearance.
    static func height(count: Int) -> CGFloat {
        let above = max(0, DockCards.rows(count: count, maxVisible: DockCards.phoneVisible) - 1)
        return above > 0 ? CGFloat(above) * (DockedCardMetrics.height + DockedCardMetrics.spacing) : 0
    }

    var body: some View {
        GeometryReader { geo in
            let origin = geo.frame(in: .global).origin
            let docked = router.ticketSheetState == .docked && router.dockedSheets.count > 1
            if docked, let top = dockInset.top, let sides = dockInset.sides {
                // From the window's bottom to 8pt above the docked sheet's top edge.
                let bottom = geo.size.height - (top - origin.y) + DockedCardMetrics.spacing
                let others = Array(router.dockedSheets.dropFirst())
                ZStack(alignment: .bottom) {
                    if expanded {
                        // Across the whole screen, behind the list.
                        DockedBackdrop(anchor: .bottom, radius: geo.size.height * 1.1)
                        Color.clear
                            .contentShape(.rect)
                            .ignoresSafeArea()
                            .onTapGesture { expanded = false }
                            .accessibilityHidden(true)
                        DockedCardList(sheets: others, total: router.dockedSheets.count, open: open, close: { router.closeSheet(id: $0.id) }, collapse: { expanded = false })
                            .padding(.horizontal, sides - origin.x)
                            .padding(.bottom, bottom)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    } else {
                        stack(others)
                            .padding(.horizontal, sides - origin.x)
                            .padding(.bottom, bottom)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height, alignment: .bottom)
            }
        }
        .animation(.snappy, value: router.dockedSheets.map(\.id))
        .animation(.snappy, value: expanded)
        .onChange(of: router.ticketSheetState) { _, s in if s != .docked { expanded = false } }
        .onChange(of: router.dockedSheets.count) { _, n in if n <= DockCards.phoneVisible { expanded = false } }
    }

    private func stack(_ others: [TicketSheet]) -> some View {
        let split = DockCards.split(count: others.count + 1, maxVisible: DockCards.phoneVisible)
        return VStack(spacing: DockedCardMetrics.spacing) {
            if split.more > 0 { DockedMoreCard(count: split.more) { expanded = true } }
            // The rest of the visible cards, oldest at the top; the top ticket is the sheet below.
            ForEach(others.prefix(max(0, split.cards - 1)).reversed()) { sheet in
                DockedCard(sheet: sheet, open: { open(sheet) }, close: { router.closeSheet(id: sheet.id) })
            }
        }
    }

    private func open(_ sheet: TicketSheet) {
        expanded = false
        router.activateSheet(id: sheet.id)
        router.restoreDock()
    }
}

extension Router {
    /// `key` is the ticket at the root of the top ticket sheet, with nothing pushed above it: its
    /// screen has no navigation bar, and its hero title is the top of the sheet.
    @MainActor func showsAsSheetRoot(_ key: String) -> Bool {
        let sheet = ticketSheet ?? dock
        return sheet?.path.isEmpty == true && sheet?.rootKey == key
    }
}
