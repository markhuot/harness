import HarnessKit
import SwiftUI

/// The board: five columns as horizontally paged lists with a status strip (counts) on top, or
/// on iPad at regular width all five side by side like the Mac (each with its own header, no
/// strip), the project filter behind the sidebar button, pull to refresh. Done is paged:
/// it scrolls into older pages (footer spinner) and its count is the server's total. On the phone
/// there's no navigation bar: our own bottom bar (BoardBottomBar) reads Projects, the command
/// palette field (always on screen, its placeholder the project's or group's name or "All projects";
/// tapping it opens the palette, PaletteScreen, which finds tickets and runs commands, "Show child
/// tickets" among them) and New session; in the iPad's DesktopShell they're in the top bar instead
/// (the palette button, ⌘K or ⌘F, and New session, ⌘N, trailing) and there's no bottom bar. The
/// board doesn't filter by a search: that's the Mac's.
struct BoardScreen: View {
    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.desktopShell) private var desktop
    @Environment(\.horizontalSizeClass) private var sizeClass

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

    private var layout: BoardScreenRules.Layout { sizeClass == .regular ? .columns : .pager }

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
        // The title still names the back button on a pushed ticket; on the phone the bar itself is
        // hidden, so the board starts right under the status bar and the field's placeholder
        // names the project instead.
        .navigationTitle(scopeName(ctx))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(desktop ? .automatic : .hidden, for: .navigationBar)
        // The columns scroll on under the phone's bar's glass.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !desktop { BoardBottomBar(placeholder: scopeName(ctx), newSession: newSessionButton(ctx)) }
        }
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
                        BoardColumnView(status: status, ctx: ctx, onDiscard: discard)
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
                                inset: EdgeInsets(top: 6, leading: 8, bottom: 10, trailing: 8))
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

    /// iPad (DesktopShell): the split view's toggle, and the palette and New session trailing. The
    /// phone has no toolbar items: BoardBottomBar holds them.
    @ToolbarContentBuilder private func toolbar(_ ctx: BoardContext) -> some ToolbarContent {
        if desktop {
            ToolbarItem(placement: .primaryAction) {
                Button("Command palette", systemImage: "magnifyingglass") { router.present(.palette(files: false)) }
            }
            ToolbarItem(placement: .primaryAction) { newSession(ctx) }
        }
    }

    private func scopeName(_ ctx: BoardContext) -> String { ctx.scopeName ?? "All projects" }

    private func newSession(_ ctx: BoardContext) -> some View {
        Button("New session", systemImage: Self.newSessionSymbol) { router.present(.newSession(projectId: ctx.project?.id, key: nil)) }
            .primaryToolbarItem(c)
    }

    /// New session as a glass circle for the phone's bar: prominent accent glass when the glyph
    /// reads in white on it, else plain glass with an accent glyph (as primaryToolbarItem decides).
    @ViewBuilder private func newSessionButton(_ ctx: BoardContext) -> some View {
        let button = Button { router.present(.newSession(projectId: ctx.project?.id, key: nil)) } label: {
            Image(systemName: Self.newSessionSymbol)
                .font(.system(size: 19, weight: .medium))
                .frame(width: 34, height: 34)
        }
        .buttonBorderShape(.circle)
        .accessibilityLabel("New session")
        if c.tokens[.onAccent].lowercased() == "#ffffff" {
            button.buttonStyle(.glassProminent).tint(c.accent)
        } else {
            button.buttonStyle(.glass).foregroundStyle(c.accent)
        }
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

/// The phone board's bottom bar, Liquid Glass floating over the columns: Projects, the command
/// palette's field and New session. The field is a button that opens the palette (a sheet with its
/// own text field), so the bar never changes shape and no keyboard fights the docked tickets.
private struct BoardBottomBar<NewSession: View>: View {
    let placeholder: String
    let newSession: NewSession

    @Environment(\.palette) private var c
    @Environment(Router.self) private var router
    /// The field capsule's height, the bar's row
    private let fieldHeight: CGFloat = DockMetrics.barHeight

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                ProjectsButton(circle: true)
                field
                newSession
            }
        }
        .padding(.top, 6)
        // Concentric with the phone's corners, like Calendar's bar. Over the docked cards, which
        // share its sides, the same gap above them on every phone.
        .concentricBottomPadding(barHeight: fieldHeight, raised: false, horizontal: DockMetrics.fallbackSides, bottom: 4,
                                 above: !router.waitingSheets.isEmpty ? TicketDock.barGap : nil)
        .animation(.snappy, value: router.waitingSheets.isEmpty)
    }

    private var field: some View {
        Button { router.present(.palette(files: false)) } label: {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(c.text2)
                Text("Search or run a command")
                    .font(.scaled(size: 17))
                    .foregroundStyle(c.text3)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: fieldHeight)
            .glassEffect(.regular.interactive(), in: .capsule)
            // Tapping anywhere on the capsule (not just the text) opens the palette.
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Command palette")
        .accessibilityHint("Search tickets or run a command in \(placeholder)")
        .accessibilityIdentifier("palette-field")
    }
}
