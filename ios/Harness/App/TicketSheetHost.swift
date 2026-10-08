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
/// sheet shows the docked tickets as minimized cards (TicketDock), growing to fit them, under the
/// board, which stays usable (`presentationBackgroundInteraction`). Tapping a card, or dragging the
/// sheet up, brings a ticket back; "N more…" stands the sheet at `.large` as the list of them all
/// (`listing`). Swiping the sheet down closes the top ticket, and so does a flick down from `.large`
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
    /// "N more…" expanded the sheet into the list of every docked ticket.
    @State private var listing = false

    var body: some View {
        let current = router.ticketSheet ?? router.dock
        let sheet = current ?? last
        // Gone, the last one stays mounted while the sheet animates away.
        let mounted = current == nil ? (last.map { [$0] } ?? []) : router.liveSheets
        let dockHeight = TicketDock.height(count: router.dockedSheets.count)
        GeometryReader { geo in
            // By height rather than state, so the cards take over as the sheet settles at the dock.
            let docked = geo.size.height < dockHeight + 60
            ZStack(alignment: .top) {
                ForEach(mounted) { s in
                    let isTop = s.id == sheet?.id
                    let shown = isTop && !docked && !listing
                    stack(s)
                        .opacity(shown ? 1 : 0)
                        .allowsHitTesting(shown)
                        .accessibilityHidden(!shown)
                        // Behind the top: no key commands (New session's Escape) either.
                        .disabled(!isTop)
                        .zIndex(isTop ? 1 : 0)
                }
                if listing && !docked {
                    DockedCardList(sheets: router.dockedSheets,
                                   open: { s in
                                       listing = false
                                       router.activateSheet(id: s.id)
                                       router.restoreDock()
                                   },
                                   close: { router.closeSheet(id: $0.id) },
                                   collapse: { listing = false })
                        .padding(.top, 12)
                        .zIndex(2)
                } else if docked, sheet != nil {
                    TicketDock(expand: { listing = true })
                        .frame(height: geo.size.height)
                        .zIndex(2)
                }
            }
            // Behind the keyboard too, so its rounded corners show the sheet's background, not the
            // system sheet's. Docked, the sheet keeps the system's glass.
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
        .background { SheetFlickTracker(flick: flick) }
        .onChange(of: current, initial: true) { _, s in if let s { last = s } }
        // Switching tickets mustn't leave the keyboard up for the one now hidden.
        .onChange(of: current?.id) { resignFirstResponder() }
        .onChange(of: router.ticketSheetState, initial: true) { _, s in
            if s != .gone { lastDocked = s == .docked }
            // A ticket came up (or they all went): the list has done its job.
            if s != .docked { listing = false }
        }
        // Few enough to show as cards: nothing left to list.
        .onChange(of: router.dockedSheets.count) { _, n in if n <= DockCards.phoneVisible { listing = false } }
        .presentationDetents([dockDetent, .large], selection: detent)
        .presentationBackgroundInteraction(.enabled(upThrough: dockDetent))
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
    private var dockDetent: PresentationDetent { TicketDock.detent(count: router.dockedSheets.count) }

    /// Listing ("N more…"), the sheet stands at `.large` over the docked state; let down, it's back
    /// to the cards, still docked.
    private var detent: Binding<PresentationDetent> {
        Binding(get: {
                    if listing { return .large }
                    switch router.ticketSheetState {
                    case .gone: return lastDocked ? dockDetent : .large
                    case .docked: return dockDetent
                    case .presented: return .large
                    }
                },
                set: { new in
                    if listing {
                        if new != .large { listing = false }
                        return
                    }
                    // Any detent but `.large` is the dock's (its height follows the cards).
                    guard new != .large else { return router.restoreDock() }
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
    /// Inside the iPad's ticket panel (TicketPanelHost), whose title bar names the ticket on top,
    /// so that ticket's screen leaves its key out of the navigation bar (TicketDetailHeader).
    @Entry var inTicketPanel = false
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
    /// The iPad: where the board's column starts in the window, right of the sidebar, so the pill
    /// stack keeps off the sidebar (DesktopShell measures it).
    var contentLeading: CGFloat = 0
}

/// Watches drags on the ticket sheet alongside the system's own, without taking any touches: a pan
/// on the sheet's container view (which holds the grabber too) that recognizes with everything.
/// Touches that pass through to the board behind never reach it.
private struct SheetFlickTracker: UIViewRepresentable {
    let flick: SheetFlick

    func makeUIView(context: Context) -> Probe { Probe(flick: flick) }
    func updateUIView(_ view: Probe, context: Context) {}

    final class Probe: UIView, UIGestureRecognizerDelegate {
        let flick: SheetFlick
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
            pan.view?.removeGestureRecognizer(pan)
            guard window != nil, let container = presentedController?.presentationController?.containerView else { return }
            container.addGestureRecognizer(pan)
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
                    Color.clear.frame(height: TicketDock.clearance(screen: screen, dockTop: dockInset?.top))
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
    }
}

extension View {
    func dockClearance() -> some View { modifier(DockClearance()) }
}

/// The docked ticket sheet's content: the docked tickets as minimized cards (DockedCard), the most
/// recent at the bottom, up to `DockCards.phoneVisible`, then "N more…" on top, which `expand`s the
/// sheet into the list of them all. A card's tap opens that ticket and its ✕ closes just it. A
/// swipe along the dock moves to the next or previous one, like Safari's tab bar. The sheet's
/// height follows the rows (`height(count:)`), and the board's bottom bar rides above it.
struct TicketDock: View {
    let expand: () -> Void
    @Environment(Router.self) private var router

    /// One card's row.
    static let rowHeight: CGFloat = 56
    /// Above the rows, under the sheet's grabber.
    static let topInset: CGFloat = 8
    /// The docked sheet's height for `count` docked tickets: a row each up to the visible two,
    /// plus "N more…".
    static func height(count: Int) -> CGFloat {
        CGFloat(max(1, DockCards.rows(count: count, maxVisible: DockCards.phoneVisible))) * rowHeight + topInset
    }
    static func detent(count: Int) -> PresentationDetent { .height(height(count: count)) }
    /// How far the board's bottom bar sits above the docked sheet, the same on every phone.
    static let barGap: CGFloat = 11

    /// What a section gives up at its bottom while a sheet is docked, so the dock sits under the
    /// board's bottom bar rather than over it: everything below the docked sheet's top edge, less
    /// the home indicator's inset the section already keeps clear. The bar keeps `barGap` above
    /// that (BoardScreen). Before the dock is measured, one row plus a guess at the float and gap.
    static func clearance(screen: ConcentricBar.Screen?, dockTop: CGFloat?) -> CGFloat {
        let homeIndicator = screen?.homeIndicator ?? 0
        guard let screen, let dockTop else { return max(0, height(count: 1) + 27 - homeIndicator) }
        return max(0, screen.height - dockTop - homeIndicator)
    }

    var body: some View {
        let sheets = router.dockedSheets
        let split = DockCards.split(count: sheets.count, maxVisible: DockCards.phoneVisible)
        let visible = Array(sheets.prefix(split.cards))
        VStack(spacing: 0) {
            if split.more > 0 {
                DockedMoreCard(count: split.more, height: Self.rowHeight, expand: expand)
                Divider().padding(.leading, 16)
            }
            // Oldest at the top, the most recent at the bottom, nearest the thumb.
            ForEach(Array(visible.reversed().enumerated()), id: \.element.id) { i, sheet in
                if i > 0 { Divider().padding(.leading, 16) }
                DockedCard(sheet: sheet, height: Self.rowHeight,
                           open: { open(sheet) }, close: { router.closeSheet(id: sheet.id) })
            }
        }
        .padding(.top, Self.topInset)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .animation(.snappy, value: sheets.map(\.id))
        // UIKit swipes rather than a SwiftUI drag, which would take vertical drags from the system
        // sheet too (its swipe down to close).
        .gesture(DockSwipe(direction: .left) { swipe(.next) })
        .gesture(DockSwipe(direction: .right) { swipe(.previous) })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ticket-dock-sheet")
        .accessibilityAction(named: "Next docked ticket") { swipe(.next) }
        .accessibilityAction(named: "Previous docked ticket") { swipe(.previous) }
    }

    private func open(_ sheet: TicketSheet) {
        router.activateSheet(id: sheet.id)
        router.restoreDock()
    }

    private func swipe(_ step: Router.DockStep) {
        guard router.dockedSheets.count > 1 else { return }
        withAnimation(.snappy) { router.activateAdjacentSheet(step) }
    }
}

/// A swipe along the dock bar: only a horizontal swipe recognizes, alongside the system sheet's own
/// pan, so a drag down still closes the docked ticket.
private struct DockSwipe: UIGestureRecognizerRepresentable {
    let direction: UISwipeGestureRecognizer.Direction
    let action: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UISwipeGestureRecognizer {
        let swipe = UISwipeGestureRecognizer()
        swipe.direction = direction
        swipe.cancelsTouchesInView = false
        swipe.delegate = context.coordinator
        return swipe
    }

    func handleUIGestureRecognizerAction(_ recognizer: UISwipeGestureRecognizer, context: Context) {
        if recognizer.state == .ended { action() }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}
