import HarnessKit
import SwiftUI

/// The board: five columns as horizontally paged lists with a status strip (counts) on top, or
/// on iPad at regular width and on a phone in landscape all five side by side like the Mac (each with its own header, no
/// strip), the project filter behind the sidebar button, pull to refresh. Done is paged:
/// it scrolls into older pages (footer spinner) and its count is the server's total. The
/// the navigation bar is never shown: the system's bottom bar holds Projects (the sidebar's toggle on
/// iPad), search (⌘K or ⌘F) and New session (⌘N), the columns run beneath it, and the last two hide
/// while a ticket panel covers them. Search is a magnifier that opens the palette, PaletteScreen,
/// which finds tickets and runs commands, "Show child tickets" among them. The docked cards float above the bar
/// (DockedSheetInset.barInset). The board doesn't filter by a search: that's the Mac's.
struct BoardScreen: View {
    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.desktopShell) private var desktop
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.concentricScreen) private var screen
    /// Told how tall the bottom bar is, for the dock's cards to float above it.
    @Environment(DockedSheetInset.self) private var dockInset: DockedSheetInset?

    /// The column on screen (the pager's scroll position).
    @State private var page: TicketStatus? = .planning
    @State private var landed = false
    /// Set while the pager scrolls because of a chip tap or a jump, so only swipes play the haptic.
    @State private var jumping = false
    /// The side-by-side columns at least partly on screen (all of them when they fit).
    @State private var visible: Set<TicketStatus> = []
    /// The side-by-side column at the leading edge (their scroll position, when they overflow).
    @State private var leading: TicketStatus?
    /// Runs the cards' menu actions; the board presents what they ask for (a context menu can't
    /// present a sheet), once for every card.
    @State private var ticketActions = TicketActionRunner()
    /// How far the system's bottom bar (and the home indicator) reaches up from the screen's edge:
    /// the columns run under it, and their last card scrolls clear of it.
    @State private var barInset: CGFloat = 0

    /// The room the last card keeps for the bottom bar the columns run under.
    /// On the phone, plus the room the docked cards floating over the bar take.
    private var belowBar: CGFloat {
        barInset + (desktop ? 0 : TicketDock.boardRoom(screen: screen, inset: dockInset, count: router.waitingSheets.count))
    }

    private var layout: BoardScreenRules.Layout { BoardScreenRules.layout(regularWidth: sizeClass == .regular, compactHeight: verticalSizeClass == .compact) }

    /// An open ticket panel covers the board's bottom-right corner, where the bar's search and New session sit.
    private var panelCoversBar: Bool { desktop && router.ticketSheet != nil }

    /// New session's icon: the pencil on a square, like Mail and Notes' compose button.
    static let newSessionSymbol = "square.and.pencil"

    var body: some View {
        let ctx = BoardContext(store.state, app.prefs)
        let layout = layout
        VStack(spacing: 0) {
            if layout == .pager {
                BoardStatusStrip(
                    page: page ?? .planning, count: { ctx.count($0) }, onTap: goTo)
            }
            if layout == .pager { pager(ctx) } else { columns(ctx) }
        }
        // The columns scroll on under the bottom bar's glass, not stop above it.
        .ignoresSafeArea(.container, edges: .bottom)
        .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.bottom } action: {
            barInset = $0
            dockInset?.barInset = $0
        }
        .onDisappear { dockInset?.barInset = 0 }
        .background(c.bg)
        .environment(ticketActions)
        .modifier(TicketActionHost(runner: ticketActions))
        // ⌘F opens the palette (⌘K is the window's); the field is its own button, so this one isn't drawn.
        .background {
            Button("Search") { router.present(.palette(files: false)) }
                .keyboardShortcut("f")
                .opacity(0)
                .accessibilityHidden(true)
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner() }
        // The title still names the back button on a pushed ticket and the iPad's window; the bar
        // itself is never shown, so the board starts right under the status bar and the project
        // is named by the search field's placeholder (portrait phone) or not at all.
        .navigationTitle(scopeName(ctx))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .toolbar { toolbar(ctx) }
        // Paging follows the board's filter (a project or a group); a refetch drops the paging (so
        // does a project changing group), so ask again when it's gone.
        .onChange(of: ctx.filter, initial: true) { _, filter in store.setBoardScope(filter) }
        .onChange(of: FirstPageKey(filter: ctx.filter, ready: store.state.ready, paging: ctx.paging), initial: true) {
            store.loader.ensureFirstPage(ctx.filter)
        }
        // Hidden children can leave the loaded Done run nearly empty: while Done is on screen, top it up.
        .onChange(of: AutofillKey(layout: layout, page: page, visible: visible, count: ctx.shown.done.count, paging: ctx.paging), initial: true) { _, k in
            if BoardScreenRules.shouldAutofillDone(k.layout, page: k.page, visible: k.visible, searching: false, visibleCount: k.count, canLoad: store.loader.canLoadMoreDone(ctx.filter)) {
                store.loader.loadMoreDone(ctx.filter)
            }
        }
        // A visit opens on the column last viewed (kept in the Router, so a layout flip or a
        // relaunch returns to it), else the most useful one: what needs you, else what's moving.
        // Side by side, the board starts at Planning like the Mac's.
        .onChange(of: store.state.ready, initial: true) { _, ready in
            guard ready, !landed else { return }
            landed = true
            if layout == .pager {
                if let first = BoardScreenRules.openingColumn(remembered: router.boardColumn, shown: ctx.shown) { jump(to: first, animated: false) }
            } else if let remembered = router.boardColumn {
                // Rotating to the side-by-side layout keeps the column in view.
                leading = remembered
            }
        }
        .onChange(of: page) { _, page in
            if jumping { jumping = false } else { haptic(.select) }
            // The phone remembers its column (the landing jump counts), so a flip or a relaunch returns to it.
            if landed, layout == .pager, let page { router.boardColumn = page }
        }
    }

    // MARK: Pager

    private func pager(_ ctx: BoardContext) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 0) {
                    ForEach(TicketStatus.allKnown, id: \.self) { status in
                        BoardColumnView(status: status, ctx: ctx, onDiscard: discard, inset: EdgeInsets(top: 14, leading: 14, bottom: 14 + belowBar, trailing: 14))
                            .containerRelativeFrame(.horizontal)
                            .id(status)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $page)
            .scrollIndicators(.hidden)
            // A new width (the iPad's sidebar hidden or shown, a rotation) keeps the old offset,
            // which strands the pager between two columns: snap back to the one on screen.
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { _, _ in
                if let page { proxy.scrollTo(page, anchor: .leading) }
            }
        }
    }

    // MARK: Side by side

    private static let columnSpacing: Double = 10
    private static let columnInset: Double = 14

    /// Every column at once, sharing the width; too narrow for five at the minimum, they keep it and
    /// the board scrolls sideways (freely, no paging). Each column scrolls and refreshes on its own.
    private func columns(_ ctx: BoardContext) -> some View {
        GeometryReader { geo in
            let sizing = BoardScreenRules.columnSizing(available: geo.size.width, spacing: Self.columnSpacing, inset: Self.columnInset)
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: Self.columnSpacing) {
                    ForEach(TicketStatus.allKnown, id: \.self) { status in
                        BoardColumnFrame(status: status, count: ctx.count(status), onTap: { reveal(status) }) {
                            BoardColumnView(
                                status: status, ctx: ctx,
                                onDiscard: discard,
                                inset: EdgeInsets(top: 6, leading: 8, bottom: 10 + belowBar, trailing: 8))
                        }
                        .frame(width: sizing.width)
                        .id(status)
                        .onScrollVisibilityChange(threshold: 0.1) { on in
                            if on { visible.insert(status) } else { visible.remove(status) }
                        }
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, Self.columnInset)
                .padding(.top, 10)
                .padding(.bottom, 10)
                .frame(height: geo.size.height, alignment: .top)
            }
            .scrollPosition(id: $leading, anchor: .leading)
            // When they all fit, every column is on screen without waiting on scroll callbacks.
            .onChange(of: sizing.scrolls, initial: true) { _, scrolls in
                if !scrolls { visible = Set(TicketStatus.allKnown) }
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .scrollIndicators(sizing.scrolls ? .automatic : .hidden)
        }
    }

    /// Scrolls a side-by-side column to the leading edge (as far as the board scrolls; a no-op when
    /// they all fit).
    private func reveal(_ s: TicketStatus) {
        withAnimation(.snappy) { leading = s }
    }

    private func goTo(_ s: TicketStatus) {
        jump(to: s, animated: true)
    }

    private func jump(to s: TicketStatus, animated: Bool) {
        guard s != page else { return }
        jumping = true
        if animated {
            withAnimation(.snappy) { page = s }
        } else {
            page = s
        }
    }

    // MARK: Toolbar

    /// The system's bottom bar everywhere: Projects leading, search and New session trailing (those
    /// two hide while a ticket panel covers them).
    @ToolbarContentBuilder private func toolbar(_ ctx: BoardContext) -> some ToolbarContent {
        ToolbarItem(placement: .bottomBar) { ProjectsButton(action: toggleProjects) }
        ToolbarSpacer(.flexible, placement: .bottomBar)
        if !panelCoversBar {
            ToolbarItem(placement: .bottomBar) {
                Button("Command palette", systemImage: "magnifyingglass") { router.present(.palette(files: false)) }
                    .accessibilityHint("Search tickets or run a command in \(scopeName(ctx))")
                    .accessibilityIdentifier("palette-field")
            }
            ToolbarItem(placement: .bottomBar) { newSession(ctx) }
        }
    }

    /// The iPad's sidebar is a column that toggles; on the phone Projects is a sheet.
    private func toggleProjects() {
        if desktop { app.setPref(\.sidebarHidden, app.prefs.sidebarHidden != true) } else { router.present(.projects) }
    }

    private func scopeName(_ ctx: BoardContext) -> String { ctx.scopeName ?? "All projects" }

    private func newSession(_ ctx: BoardContext) -> some View {
        Button("New session", systemImage: Self.newSessionSymbol) { router.present(.newSession(projectId: ctx.project?.id, key: nil)) }
            .primaryToolbarItem(c)
    }

    // MARK: Drafts

    private var api: HarnessClient? { store.api }

    private func discard(_ t: Ticket) {
        guard let api else { return }
        actions.perform { _ = try await api.deleteTicket(t.key) }
    }

    // MARK: onChange keys

    private struct FirstPageKey: Equatable {
        let filter: String?
        let ready: Bool
        let paging: DonePaging?
    }

    private struct AutofillKey: Equatable {
        let layout: BoardScreenRules.Layout
        let page: TicketStatus?
        let visible: Set<TicketStatus>
        let count: Int
        let paging: DonePaging?
    }
}

/// What every part of the board reads, computed once per render.
struct BoardContext {
    let state: BoardState
    /// The board's filter (BoardState.boardFilter): a project id, a group's scope, or nil for All
    /// projects; a project or group that's gone reads as nil.
    let filter: String?
    /// The filter's project (nil on All projects and a group's board).
    let project: Project?
    /// The filter's group, on a group's board.
    let group: String?
    let board: Columns
    let pending: Bool
    /// The columns as shown: the board with children hidden per the pref.
    let shown: Columns
    /// Every ticket on the board, Done counted by the server's total.
    let total: Int
    let paging: DonePaging?


    init(_ state: BoardState, _ prefs: Prefs) {
        // The palette searches through the board's loader (BoardState.search) for its ticket rows; the
        // board itself never filters by it.
        var state = state
        state.search = nil
        self.state = state
        let id = state.boardFilter(prefs.boardProject)
        filter = id
        group = id.flatMap(Paging.scopeGroup)
        project = id.flatMap { state.projects[$0] }
        board = state.boardColumns(id)
        // The same columns presence reports (BoardColumns.shownKeys).
        (shown, pending) = BoardColumns.shownColumns(state, filter: id, board: board, hideChildren: prefs.hideChildren)
        let b = board
        total = TicketStatus.allKnown.reduce(0) { n, s in n + (s == .done ? Paging.doneCount(state, id, loaded: b.done.count) : b[s].count) }
        paging = state.donePaging[Paging.scopeOf(id)]
    }

    /// The project's or group's name (nil on All projects).
    var scopeName: String? { project?.name ?? group }

    func count(_ s: TicketStatus) -> Int {
        BoardColumns.columnCount(state, filter, shown: shown, status: s, searching: false)
    }
}
