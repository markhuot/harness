import HarnessKit
import SwiftUI

/// The ticket sheets (`Router.dockedSheets`, the top `Router.ticketSheet`) at every width: a plain
/// system sheet (the form-sized one at regular width), presented only
/// while a ticket is presented (`Router.ticketSheetState == .presented`). It is TicketSheetContent,
/// the top ticket (or New session) in its own NavigationStack, so a child, dep or parent pushes inside
/// the sheet and Back returns. Every live sheet (`Router.liveSheets`) keeps its stack mounted behind
/// the top one, hidden, so switching swaps the content in place (no re-present) and keeps drafts,
/// scroll and path while the sheet is up.
///
/// The system does the drag, its momentum and the dismissal, and the app never inspects them: a swipe
/// away closes the ticket (RootView's binding calls `Router.sheetDismissedBySystem`). Docking is a
/// separate, deliberate act: drag the sheet below its quarter-open stop and hold in the bottom fifth of the screen (DockHold,
/// DockArming) and a ghost dock card shows; releasing then docks. VoiceOver has a "Dock" action
/// instead. A docked ticket is a card in the dock (DockedCardsContainer in DockWindow), which sits
/// above the board and this sheet alike, so the other docked tickets show over the open ticket too;
/// tapping a card swaps the sheet to that ticket, or presents it again from the board.
///
/// Pickers and covers come up over it: the root is busy presenting this, so
/// they're presented from here. Projects docks it instead (`Router.open(.sheet(.projects))`), and
/// anything the board behind presents (an alert in Settings, say) has UIKit dismiss it, which the
/// root's binding turns into `dismissSheet()`. New session drafts are saved either way.
///
/// The sheet rises from the bottom everywhere, and the system's own presentation decides the rest.
/// On an iPhone Duo held in the book pose (`\.devicePosture`) it takes the right half of the screen
/// (`TicketSheetPlacement`); a quarter-open detent (`peek`) is offered next to the full one where the
/// system honors detents (not the form sheet). Quarter open, the board above it stays live and
/// undimmed: a scroll moves it, and a card tapped there opens in the sheet (the ticket it showed goes
/// to the dock).
struct TicketSheetHost: View {
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @Environment(DockHold.self) private var hold
    /// The sheet as it was last up, so its content stays while it animates away.
    @State private var last: TicketSheet?
    /// Where the system sheet rests: full height by default, or quarter open.
    @State private var detent: PresentationDetent = .large
    /// The sheet's height at `.large`, once it has been there (nil until then).
    @State private var fullHeight: CGFloat?
    @State private var fullWidth: CGFloat = 0
    @Environment(\.ticketSheetStartsQuarterOpen) private var startsQuarterOpen
    @Environment(\.devicePosture) private var posture
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// The lower stop: a quarter of full height.
    static let peek = PresentationDetent.fraction(TicketSheetPlacement.peekFraction)

    /// The sheet's full height before it has been measured (it opened quarter open): the window less
    /// the gap the large detent leaves above it.
    private static var estimatedFullHeight: CGFloat? {
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        return window.map { $0.bounds.height - $0.safeAreaInsets.top - 10 }
    }

    var body: some View {
        let current = router.ticketSheet
        let sheet = current ?? last
        // Gone, the last one stays mounted while the sheet animates away.
        let mounted = current == nil ? (last.map { [$0] } ?? []) : router.liveSheets
        let stacks = ZStack(alignment: .top) {
            ForEach(mounted) { s in
                let isTop = s.id == sheet?.id
                stack(s)
                    .environment(\.sheetFront, isTop)
                    .opacity(isTop ? 1 : 0)
                    .allowsHitTesting(isTop)
                    .accessibilityHidden(!isTop)
                    // Behind the top: no key commands (New session's Escape) either.
                    .disabled(!isTop)
                    .zIndex(isTop ? 1 : 0)
            }
        }
        // Quarter open, the content keeps its full-height layout, hung from the sheet's top, and the
        // sheet clips its bottom: the header stays exactly as it is at full height instead of
        // reflowing into the short room. The clear base takes the sheet's size whatever the content is.
        Color.clear
            .overlay(alignment: .top) {
                stacks.frame(height: detent == Self.peek ? (fullHeight ?? Self.estimatedFullHeight) : nil, alignment: .top)
            }
        .background {
            GeometryReader { proxy in
                Color.clear.onChange(of: proxy.size, initial: true) { _, size in
                    // The tallest the sheet has been at this width is its full height (the keyboard
                    // and a drag only shrink it).
                    if size.width != fullWidth { fullWidth = size.width; fullHeight = nil }
                    if size.height > (fullHeight ?? 0) { fullHeight = size.height }
                }
            }
        }
        // Behind the keyboard too, so its rounded corners show the sheet's background, not the
        // system sheet's.
        .background { c.bg.ignoresSafeArea() }
        .background {
            DockHoldHost(hold: hold) {
                withAnimation(.snappy) { router.dockSheet() }
            }
        }
        // The hold gesture has no VoiceOver equivalent: this is it.
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Dock") { withAnimation(.snappy) { router.dockSheet() } }
        .onChange(of: current, initial: true) { _, s in if let s { last = s } }
        // Switching tickets mustn't leave the keyboard up for the one now hidden.
        .onChange(of: current?.id) {
            resignFirstResponder()
            // A ticket opened over the quarter-open one (the old one docks) comes up at full height.
            if TicketSheetPlacement.opensFullHeightAfterTicketChange(quarterOpen: detent == Self.peek) {
                withAnimation(.snappy) { detent = .large }
            }
        }
        .presentationDragIndicator(.visible)
        .presentationDetents([Self.peek, .large], selection: $detent)
        // Quarter open, the board behind takes touches; full height, it stays dimmed and inert.
        .presentationBackgroundInteraction(.enabled(upThrough: Self.peek))
        // Quarter open the sheet sits over a live board, so its edge gets a darker shadow to stand apart.
        .presentationBackground {
            UnevenRoundedRectangle(topLeadingRadius: 38, topTrailingRadius: 38)
                .fill(c.bg)
                .shadow(color: .black.opacity(detent == Self.peek ? 0.35 : 0), radius: 14, y: -2)
                .ignoresSafeArea()
        }
        .onAppear { if startsQuarterOpen { detent = Self.peek } }
        .ticketSheetPresentation(TicketSheetPlacement.placement(for: posture), regularWidth: sizeClass == .regular)
        // The window's chords don't fire under a sheet: the palette's are here too.
        .hiddenShortcuts { PaletteShortcuts(router: router) }
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

/// A ticket sheet's content (TicketSheetHost): the ticket (or New session) in its own NavigationStack, bound to that
/// sheet's path, so a child, dep or parent pushes inside it and Back returns. Each screen's toolbar
/// carries the docked tickets' switcher while there's more than one.
struct TicketSheetContent: View {
    let sheet: TicketSheet
    /// Each screen runs to the screen's bottom edge, keeping no inset there but
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

    private func screen(_ screen: some View) -> some View {
        // The room for the dock goes inside the stack's screens, like the board's (DockClearance): the
        // bottom-edge modifier below would ignore it outside.
        bottomEdge(toBottomEdge ? AnyView(screen.modifier(SheetDockRoom())) : AnyView(screen))
    }

    @ViewBuilder private func bottomEdge(_ screen: some View) -> some View {
        if toBottomEdge { screen.ignoresSafeArea(.container, edges: .bottom) } else { screen }
    }

    @ViewBuilder private var root: some View {
        switch sheet.root {
        case let .ticket(key, tab): RouteScreen(route: .ticket(key: key, tab: tab))
        case let .newSession(projectId, key): NewSessionScreen(projectId: projectId, key: key)
        case let .terminal(id): TerminalSheetScreen(id: id, cardID: sheet.id)
        case let .cos(scope): CosScreen(scope: scope)
        case let .file(params): FileViewerScreen(params: params, cardID: sheet.id, reveal: router.dockedSheets.first { $0.id == sheet.id }?.revealed ?? sheet.revealed)
        }
    }
}

extension EnvironmentValues {
    /// Inside the ticket sheet's stack (TicketSheetContent): a link there is a
    /// step within the sheet rather than a new choice from outside it (`Router.openTicket`).
    @Entry var inTicketSheet = false
    /// False while the ticket sheet isn't at its resting size (the system shrinks it
    /// under a finger, and springs it back): measurements that depend on where the ticket's edges
    /// are (TicketDetailBody's bottom room) wait for it to rest.
    @Entry var sheetResting = true
    /// False while a docked sheet is mounted behind the top one (or minimized to its card): hidden,
    /// it has lost focus, which a file's editor saves for (Save on blur).
    @Entry var sheetFront = true
    /// The ticket sheet comes up quarter open rather than at full height: a screen test sets it.
    @Entry var ticketSheetStartsQuarterOpen = false
}

/// Where the docked cards float, as last measured. The dock is in a window of its own, so this
/// reaches the sections (DockClearance), the board's bottom bar and the ticket's composer through the
/// environment (RootView) rather than a preference; they sit above the dock while
/// `Router.waitingSheets` has cards.
@Observable final class DockedSheetInset {
    /// The top edge of the whole collapsed card stack in the window (the topmost card or "N more…"),
    /// which the sections' clearance and the board's bar sit above. Nil until measured.
    var stackTop: CGFloat?
    /// How far the board's system bottom bar (the home indicator included) reaches up from the screen's
    /// edge: the phone's dock floats its cards above it. 0 while the board isn't the screen showing.
    /// The ticket sheet covers the board without changing it, so the cards stay put under it.
    var barInset: CGFloat = 0
    /// The board's system bar as measured (its buttons' edges), which the cards take the width of. Nil
    /// while the board isn't the screen showing.
    var boardBar: DockBar?
    /// The front ticket sheet's screen has a composer, which keeps its own room above it for the cards.
    var composerUp = false
    /// The top edge of that composer in the window, which the cards rest above when the sheet doesn't
    /// run to the screen's bottom (a form sheet at regular width). Nil with no composer up.
    var composerTop: CGFloat?
    /// A keyboard is up: the dock is faded out, so the ticket's composer keeps no room for it.
    var keyboardUp = false
}

/// Keeps a section's screen clear of the docked cards. It goes inside the section's
/// NavigationStack, on each screen: a safe-area inset outside the stack doesn't reach the board's
/// own bottom bar. Not while a keyboard is up: the dock is behind it.
private struct DockClearance: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(\.concentricScreen) private var screen
    @Environment(DockedSheetInset.self) private var dockInset: DockedSheetInset?
    /// The board makes room above its own system bottom bar (BoardScreen), not below it.
    let board: Bool

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !board && !router.waitingSheets.isEmpty {
                    // The whole card stack, up to its measured top edge. Keyboard or not: the
                    // cards stay where they are, behind it.
                    Color.clear.frame(height: TicketDock.clearance(screen: screen, stackTop: dockInset?.stackTop, count: router.waitingSheets.count))
                }
            }
    }
}

extension View {
    /// `board`: the board's own screen, which keeps its room above its system bottom bar itself.
    func dockClearance(board: Bool = false) -> some View { modifier(DockClearance(board: board)) }
}

/// What the ticket sheet's screens keep clear at the bottom while other tickets wait in the dock,
/// which is drawn over the sheet: everything below the top of the card stack (the sheet runs to the
/// screen's edge, so no home indicator's inset is left over). A screen with a composer keeps its own
/// room above the composer instead (`TicketDock.stackRoom`), where the cards float. None while a
/// keyboard is up, where the dock is hidden and the composer rides the keyboard.
private struct SheetDockRoom: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(\.concentricScreen) private var screen
    @Environment(DockedSheetInset.self) private var dockInset: DockedSheetInset?

    func body(content: Content) -> some View {
        let room = dockInset?.composerUp != true && dockInset?.composerTop == nil ?TicketDock.sheetRoom(cards: router.waitingSheets.count, screen: screen, inset: dockInset) : 0
        content
            .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: room) }
            .animation(.snappy, value: room)
    }
}


/// The clearance the phone's sections and the ticket sheet keep for the docked cards.
@MainActor enum TicketDock {
    /// One card's height.
    static let height = DockedCardMetrics.height
    /// What the board gives up above its system bottom bar while tickets are docked, so the last
    /// cards scroll clear of the dock floating over the bar.
    static func boardRoom(screen: ConcentricBar.Screen?, inset: DockedSheetInset?, count: Int) -> CGFloat {
        guard count > 0 else { return 0 }
        return DockMetrics.boardClearance(screenHeight: screen?.height, stackTop: inset?.stackTop, barInset: inset?.barInset ?? 0,
                                          rows: DockCards.rows(count: count, maxVisible: DockCards.phoneVisible))
    }

    /// What a section gives up at its bottom while tickets are docked, so the cards sit under the
    /// board's bottom bar rather than over it: everything below the bottom card's top edge, less
    /// the home indicator's inset the section already keeps clear. Before the card is measured, one card plus its gap.
    static func clearance(screen: ConcentricBar.Screen?, stackTop: CGFloat?, count: Int) -> CGFloat {
        DockMetrics.clearance(screenHeight: screen?.height, stackTop: stackTop, homeIndicator: screen?.homeIndicator ?? 0,
                              rows: DockCards.rows(count: count, maxVisible: DockCards.phoneVisible))
    }

    /// What the ticket sheet's screens give up at their bottom for `cards` waiting tickets: 0 with
    /// none, or with a keyboard up (the dock is hidden then).
    static func sheetRoom(cards: Int, screen: ConcentricBar.Screen?, inset: DockedSheetInset?) -> CGFloat {
        guard cards > 0, inset?.keyboardUp != true else { return 0 }
        return DockMetrics.clearance(screenHeight: screen?.height, stackTop: inset?.stackTop, homeIndicator: 0,
                                     rows: DockCards.rows(count: cards, maxVisible: DockCards.phoneVisible))
    }

    /// What a ticket screen keeps clear above its composer for the cards floating over it: the stack
    /// and its gap to the composer. None without cards, or with a keyboard up (the dock is hidden then).
    static func stackRoom(cards: Int, inset: DockedSheetInset?) -> CGFloat {
        guard cards > 0, inset?.keyboardUp != true else { return 0 }
        return DockMetrics.stackHeight(rows: DockCards.rows(count: cards, maxVisible: DockCards.phoneVisible)) + DockMetrics.phoneBottomGap
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
