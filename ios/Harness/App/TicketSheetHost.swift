import HarnessKit
import SwiftUI

/// The ticket sheets (`Router.dockedSheets`, the top `Router.ticketSheet`) at compact width (iPhone,
/// and a narrow iPad window; regular width is TicketPanelHost): a plain system sheet, presented only
/// while a ticket is presented (`Router.ticketSheetState == .presented`). It is TicketSheetContent,
/// the top ticket (or New session) in its own NavigationStack, so a child, dep or parent pushes inside
/// the sheet and Back returns. Every live sheet (`Router.liveSheets`) keeps its stack mounted behind
/// the top one, hidden, so switching swaps the content in place (no re-present) and keeps drafts,
/// scroll and path while the sheet is up.
///
/// The system does the drag, its momentum and the dismissal, and the app never inspects them: a swipe
/// away closes the ticket (RootView's binding calls `Router.sheetDismissedBySystem`). Docking is a
/// separate, deliberate act: drag the sheet down and hold in the bottom 40% of the screen (DockHold,
/// DockArming) and a ghost dock card shows; releasing then docks. VoiceOver has a "Dock" action
/// instead. A docked ticket is a card in the main window (DockedCardsOverlay), over the board, with
/// the other docked tickets stacked above it; tapping one presents the sheet again.
///
/// Pickers, the watcher form and covers come up over it: the root is busy presenting this, so
/// they're presented from here. Projects closes it instead (`Router.open(.sheet(.projects))`), and
/// anything the board behind presents (an alert in Settings, say) has UIKit dismiss it, which the
/// root's binding turns into `dismissSheet()`. New session drafts are saved either way.
struct TicketSheetHost: View {
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @Environment(DockHold.self) private var hold
    /// The sheet as it was last up, so its content stays while it animates away.
    @State private var last: TicketSheet?

    var body: some View {
        let current = router.ticketSheet
        let sheet = current ?? last
        // Gone, the last one stays mounted while the sheet animates away.
        let mounted = current == nil ? (last.map { [$0] } ?? []) : router.liveSheets
        ZStack(alignment: .top) {
            ForEach(mounted) { s in
                let isTop = s.id == sheet?.id
                stack(s)
                    .opacity(isTop ? 1 : 0)
                    .allowsHitTesting(isTop)
                    .accessibilityHidden(!isTop)
                    // Behind the top: no key commands (New session's Escape) either.
                    .disabled(!isTop)
                    .zIndex(isTop ? 1 : 0)
            }
        }
        // Behind the keyboard too, so its rounded corners show the sheet's background, not the
        // system sheet's.
        .background { c.bg.ignoresSafeArea() }
        .background {
            DockHoldHost(hold: hold, title: sheet?.title ?? "", palette: c) {
                withAnimation(.snappy) { router.dockSheet() }
            }
        }
        // The hold gesture has no VoiceOver equivalent: this is it.
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Dock") { withAnimation(.snappy) { router.dockSheet() } }
        .onChange(of: current, initial: true) { _, s in if let s { last = s } }
        // Switching tickets mustn't leave the keyboard up for the one now hidden.
        .onChange(of: current?.id) { resignFirstResponder() }
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
    /// False while the iPhone's ticket sheet isn't at its resting size (the system shrinks it
    /// under a finger, and springs it back): measurements that depend on where the ticket's edges
    /// are (TicketDetailBody's bottom room) wait for it to rest.
    @Entry var sheetResting = true
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
                        + DockedCardsOverlay.height(count: router.dockedSheets.count))
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
    }
}

extension View {
    func dockClearance() -> some View { modifier(DockClearance()) }
}


/// What opens, closes and steps the docked tickets on the phone: the card's tap, swipes and VoiceOver
/// actions, and the clearance the board keeps for the cards.
@MainActor enum TicketDock {
    /// One card's height.
    static let height = DockedCardMetrics.height
    /// How far the board's bottom bar sits above the docked cards, the same on every phone.
    static let barGap = DockMetrics.barGap

    /// What a section gives up at its bottom while a ticket is docked, so the cards sit under the
    /// board's bottom bar rather than over it: everything below the bottom card's top edge, less
    /// the home indicator's inset the section already keeps clear. The bar keeps `barGap` above
    /// that (BoardScreen). Before the card is measured, one card plus its gap.
    static func clearance(screen: ConcentricBar.Screen?, dockTop: CGFloat?) -> CGFloat {
        let homeIndicator = screen?.homeIndicator ?? 0
        guard let screen, let dockTop else { return max(0, height + DockMetrics.phoneBottomGap - homeIndicator + 19) }
        return max(0, screen.height - dockTop - homeIndicator)
    }

    /// The next or previous docked ticket on top: a swipe along the card or VoiceOver's actions.
    static func step(_ router: Router, _ step: Router.DockStep) {
        guard router.dockedSheets.count > 1 else { return }
        withAnimation(.snappy) { router.activateAdjacentSheet(step) }
    }

    /// Tapping the card: it hides and the sheet is presented, in one transaction.
    static func open(_ router: Router) { withAnimation(.snappy) { router.restoreDock() } }
}

/// The phone's docked tickets as cards over the board, in the main window: the top ticket's card at
/// the bottom, 8pt above the home indicator, as wide as the sheet was, with the others' cards and
/// "N more…" stacked above it, up to `DockCards.phoneVisible` in all. "N more…" expands every one but
/// the top into a scrolling list on a DockedBackdrop rising out of the bottom. A tap opens the top
/// card, a horizontal swipe along it moves to the next or previous ticket, and a swipe down or its ✕
/// closes it. It's an overlay rather than a second sheet because a sheet would pop in after the
/// dismissal and bring back its own rim and shadow. The keyboard doesn't lift it.
struct DockedCardsOverlay: View {
    @Environment(Router.self) private var router
    @Environment(DockedSheetInset.self) private var dockInset
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @AccessibilityFocusState private var focused: Bool

    /// The rows above the bottom card for `count` docked tickets, with their gaps: what the
    /// sections give up on top of the bottom card's clearance.
    static func height(count: Int) -> CGFloat {
        let above = max(0, DockCards.rows(count: count, maxVisible: DockCards.phoneVisible) - 1)
        return above > 0 ? CGFloat(above) * (DockedCardMetrics.height + DockedCardMetrics.spacing) : 0
    }

    var body: some View {
        GeometryReader { geo in
            let docked = router.ticketSheetState == .docked
            ZStack(alignment: .bottom) {
                if docked, let top = router.dockedSheets.first {
                    let others = Array(router.dockedSheets.dropFirst())
                    if expanded {
                        // Across the whole screen, behind the list.
                        DockedBackdrop(anchor: .bottom, radius: geo.size.height * 1.1)
                        Color.clear
                            .contentShape(.rect)
                            .ignoresSafeArea()
                            .onTapGesture { expanded = false }
                            .accessibilityHidden(true)
                    }
                    VStack(spacing: DockedCardMetrics.spacing) {
                        if expanded {
                            DockedCardList(sheets: others, total: router.dockedSheets.count, open: open, close: { router.closeSheet(id: $0.id) }, collapse: { expanded = false })
                        } else {
                            stack(others)
                        }
                        primary(top)
                    }
                    .padding(.horizontal, DockMetrics.phoneSides)
                    .padding(.bottom, DockMetrics.phoneBottomGap)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .bottom)
            // Where the bottom card sits, for the sections' clearance and the board's bar.
            .onChange(of: geo.frame(in: .global).maxY, initial: true) { _, maxY in
                dockInset.sides = DockMetrics.phoneSides
                dockInset.top = maxY - DockMetrics.phoneBottomGap - DockedCardMetrics.height
            }
        }
        .ignoresSafeArea(.keyboard)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .snappy, value: router.ticketSheetState)
        .animation(.snappy, value: router.dockedSheets.map(\.id))
        .animation(.snappy, value: expanded)
        .onChange(of: router.ticketSheetState) { _, s in
            if s != .docked { expanded = false } else { focused = true }
        }
        .onChange(of: router.dockedSheets.count) { _, n in if n <= DockCards.phoneVisible { expanded = false } }
    }

    /// The top ticket's card, with the swipes and VoiceOver's actions.
    private func primary(_ sheet: TicketSheet) -> some View {
        DockedCard(sheet: sheet, open: { TicketDock.open(router) }, close: { withAnimation(.snappy) { router.dismissSheet() } })
            .accessibilityFocused($focused)
            // High priority: the card's button would otherwise keep a drag that stays inside it
            // and take its lift as a tap. A tap never travels the 24pt, so it still reaches the button.
            .highPriorityGesture(
                DragGesture(minimumDistance: 24)
                    .onEnded { v in
                        if abs(v.translation.width) > abs(v.translation.height) {
                            TicketDock.step(router, v.translation.width < 0 ? .next : .previous)
                        } else if v.translation.height > 40 {
                            withAnimation(.snappy) { router.dismissSheet() }
                        }
                    }
            )
            .accessibilityAction(named: "Next docked ticket") { TicketDock.step(router, .next) }
            .accessibilityAction(named: "Previous docked ticket") { TicketDock.step(router, .previous) }
    }

    private func stack(_ others: [TicketSheet]) -> some View {
        let split = DockCards.split(count: others.count + 1, maxVisible: DockCards.phoneVisible)
        return VStack(spacing: DockedCardMetrics.spacing) {
            if split.more > 0 { DockedMoreCard(count: split.more) { expanded = true } }
            // The rest of the visible cards, oldest at the top; the top ticket is the card below.
            ForEach(others.prefix(max(0, split.cards - 1)).reversed()) { sheet in
                DockedCard(sheet: sheet, open: { open(sheet) }, close: { router.closeSheet(id: sheet.id) })
            }
        }
    }

    private func open(_ sheet: TicketSheet) {
        expanded = false
        withAnimation(.snappy) {
            router.activateSheet(id: sheet.id)
            router.restoreDock()
        }
    }
}

extension Router {
    /// `key` is the ticket at the root of the top ticket sheet, with nothing pushed above it: its
    /// screen has no navigation bar, and its hero title is the top of the sheet.
    @MainActor func showsAsSheetRoot(_ key: String) -> Bool {
        let sheet = ticketSheet
        return sheet?.path.isEmpty == true && sheet?.rootKey == key
    }
}
