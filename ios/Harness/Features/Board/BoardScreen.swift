import HarnessKit
import SwiftUI

/// The board: five columns as horizontally paged lists with a status strip
/// (counts) on top, the project filter behind the sidebar button, pull to refresh. Done is paged:
/// it scrolls into older pages (footer spinner) and its count is the server's total. The bottom
/// bar reads filter ("Show child tickets", off by default), the search field (always on screen)
/// and New session; in the iPad's DesktopShell they're in the top bar instead (search in the
/// navigation bar, ⌘F; Filter and New session, ⌘N, trailing) and there's no bottom bar. Typing
/// searches on the server; results page the same way, across every column.
struct BoardScreen: View {
    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.desktopShell) private var desktop

    /// The column on screen (the pager's scroll position).
    @State private var page: TicketStatus? = .planning
    @State private var landed = false
    /// Set while the pager scrolls because of a chip tap or a jump, so only swipes play the haptic.
    @State private var jumping = false
    /// The chip a dragged card hovers over.
    @State private var dropChip: TicketStatus?
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        let ctx = BoardContext(store.state, app.prefs)
        VStack(spacing: 0) {
            BoardStatusStrip(
                page: page ?? .planning, count: { ctx.count($0) }, dropChip: dropChip,
                onTap: goTo, onDrop: { key, s in dropOnChip(key, s, ctx) }, onTarget: { s, on in
                    if on { dropChip = s } else if dropChip == s { dropChip = nil }
                })
            if let search = ctx.search { BoardSearchNote(search: search) { store.loader.retrySearch() } }
            pager(ctx)
        }
        .background(c.bg)
        // ⌘F focuses the search field; the field is its own button, so this one isn't drawn.
        .background {
            Button("Search") { searchFocused = true }
                .keyboardShortcut("f")
                .opacity(0)
                .accessibilityHidden(true)
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner() }
        .navigationTitle(ctx.project?.name ?? "All projects")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: desktop ? .toolbar : .automatic, prompt: ctx.project.map { "Search \($0.name)" } ?? "Search tickets")
        .searchFocused($searchFocused)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .toolbar { toolbar(ctx) }
        // Paging follows the project filter; a refetch drops the paging, so ask again when it's gone.
        .onChange(of: ctx.projectId, initial: true) { _, id in store.setBoardScope(id) }
        .onChange(of: FirstPageKey(projectId: ctx.projectId, ready: store.state.ready, paging: ctx.paging), initial: true) {
            store.loader.ensureFirstPage(ctx.projectId)
        }
        // Every keystroke: local matches at once, the server's after a pause (BoardLoader).
        .onChange(of: SearchKey(query: query, projectId: ctx.projectId), initial: true) { _, k in
            store.loader.setQuery(k.query, projectId: k.projectId)
        }
        // Hidden children can leave the loaded Done run nearly empty: while Done is on screen, top it up.
        .onChange(of: AutofillKey(searching: ctx.searching, onDone: page == .done, count: ctx.shown.done.count, paging: ctx.paging), initial: true) { _, k in
            if !k.searching && k.onDone && BoardLoader.shouldAutoFill(visibleCount: k.count, canLoad: store.loader.canLoadMoreDone(ctx.projectId)) {
                store.loader.loadMoreDone(ctx.projectId)
            }
        }
        // The first visit lands on the most useful column: what needs you, else what's moving.
        .onChange(of: store.state.ready, initial: true) { _, ready in
            guard ready, !landed else { return }
            landed = true
            if let first = BoardScreenRules.landingColumn(ctx.shown) { jump(to: first, animated: false) }
        }
        // When search results land and the column on screen has none, show the first one that does.
        .onChange(of: ctx.search?.ids) { _, ids in
            guard ids != nil, let s = BoardScreenRules.columnWithResults(ctx.shown, current: page ?? .planning) else { return }
            goTo(s)
        }
        .onChange(of: page) { _, _ in
            if jumping { jumping = false } else { haptic(.select) }
        }
    }

    // MARK: Pager

    private func pager(_ ctx: BoardContext) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 0) {
                    ForEach(TicketStatus.allKnown, id: \.self) { status in
                        BoardColumnView(
                            status: status, ctx: ctx,
                            onMove: { t, s, w in move(t, BoardColumns.moveBody(t, to: s, w, cols: ctx.board), to: s) },
                            onDrop: { key, before in dropOnCard(key, status, before: before, ctx) },
                            onDiscard: discard)
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

    /// Phone: sidebar in the header; filter, search field and New session along the bottom.
    /// iPad (DesktopShell): the split view's toggle, the search field in the navigation bar, and
    /// Filter and New session trailing.
    @ToolbarContentBuilder private func toolbar(_ ctx: BoardContext) -> some ToolbarContent {
        if desktop {
            ToolbarItem(placement: .primaryAction) { filterMenu }
            ToolbarItem(placement: .primaryAction) { newSession(ctx).keyboardShortcut("n") }
        } else {
            SidebarToolbarItem()
            ToolbarItem(placement: .bottomBar) { filterMenu }
            // Its own glass, not tucked into the search field's.
            ToolbarSpacer(.fixed, placement: .bottomBar)
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) { newSession(ctx) }
        }
    }

    private var filterMenu: some View {
        Menu {
            Toggle("Show child tickets", systemImage: "arrow.turn.down.right", isOn: Binding(
                get: { !app.prefs.hideChildren }, set: { app.setPref(\.hideChildren, !$0) }))
        } label: {
            // Filled while the board shows more than its default (child tickets).
            Label("Filter", systemImage: app.prefs.hideChildren
                ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
        }
    }

    private func newSession(_ ctx: BoardContext) -> some View {
        Button("New session", systemImage: "plus") { router.present(.newSession(projectId: ctx.projectId, key: nil)) }
            .primaryToolbarItem(c)
    }

    // MARK: Moves

    private var api: HarnessClient? { store.api }

    /// Optimistic; the service's event confirms it. A failed update refetches the board.
    private func move(_ t: Ticket, _ m: BoardColumns.Move?, to status: TicketStatus) {
        guard let m, let api else { return }
        store.dispatch(.event(.ticketUpserted(ticket: m.applied(to: t))))
        let message = t.status != status ? "\(Keys.keyLabel(t)) → \(statusLabel(status))" : nil
        let body = m.updateBody
        Task {
            if await actions.run(message, { try await api.updateTicket(t.key, body) }) == nil { await store.refresh() }
        }
    }

    private func dropped(_ key: String) -> Ticket? {
        guard let t = store.state.ticketByKey(key), t.draft != true else { return nil }
        return t
    }

    /// A card dropped on another card sits just above it.
    private func dropOnCard(_ key: String, _ status: TicketStatus, before: String?, _ ctx: BoardContext) -> Bool {
        guard let t = dropped(key), let m = BoardScreenRules.dropMove(t, to: status, before: before, cols: ctx.board) else { return false }
        haptic(.success)
        move(t, m, to: status)
        return true
    }

    /// A card dropped on a status chip goes to the bottom of that column (Done: newest).
    private func dropOnChip(_ key: String, _ status: TicketStatus, _ ctx: BoardContext) -> Bool {
        dropChip = nil
        guard let t = dropped(key), t.status != status else { return false }
        haptic(.success)
        move(t, BoardColumns.moveBody(t, to: status, .bottom, cols: ctx.board), to: status)
        return true
    }

    private func discard(_ t: Ticket) {
        guard let api else { return }
        actions.perform("Draft discarded") { _ = try await api.deleteTicket(t.key) }
    }

    // MARK: onChange keys

    private struct FirstPageKey: Equatable {
        let projectId: String?
        let ready: Bool
        let paging: DonePaging?
    }

    private struct SearchKey: Equatable {
        let query: String
        let projectId: String?
    }

    private struct AutofillKey: Equatable {
        let searching: Bool
        let onDone: Bool
        let count: Int
        let paging: DonePaging?
    }
}

/// What every part of the board reads, computed once per render.
struct BoardContext {
    let state: BoardState
    /// The project filter, when that project still exists.
    let projectId: String?
    let project: Project?
    /// The search in the toolbar's field (nil while it's empty).
    let search: SearchState?
    let board: Columns
    let pending: Bool
    /// The columns as shown: search results (children included: hiding one would read as "not
    /// found"), else the board with children hidden per the pref.
    let shown: Columns
    /// Every ticket on the board, Done counted by the server's total.
    let total: Int
    let paging: DonePaging?

    var searching: Bool { search != nil }

    init(_ state: BoardState, _ prefs: Prefs) {
        self.state = state
        let id = prefs.boardProject.flatMap { state.projects[$0] != nil ? $0 : nil }
        projectId = id
        project = id.flatMap { state.projects[$0] }
        search = state.search
        board = state.boardColumns(id)
        if search != nil {
            let results = Paging.searchColumns(state, id)
            shown = results.columns
            pending = results.pending
        } else {
            shown = BoardColumns.visibleColumns(board, hideChildren: prefs.hideChildren)
            pending = false
        }
        let b = board
        total = TicketStatus.allKnown.reduce(0) { n, s in n + (s == .done ? Paging.doneCount(state, id, loaded: b.done.count) : b[s].count) }
        paging = state.donePaging[Paging.scopeOf(id)]
    }

    func count(_ s: TicketStatus) -> Int {
        BoardColumns.columnCount(state, projectId, shown: shown, status: s, searching: searching)
    }
}

/// "Searching…", "12 matches", or the error with Retry, under the strip; changes are announced.
private struct BoardSearchNote: View {
    let search: SearchState
    let onRetry: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        let text = Paging.searchStatusText(search)
        HStack(spacing: 8) {
            if (search.ids == nil || search.loading) && search.error == nil { Spinner().controlSize(.small) }
            Text(text)
                .font(.scaled(size: 13))
                .foregroundStyle(search.error != nil ? c.red : c.text3)
                .lineLimit(1)
            if search.error != nil {
                Button("Retry", action: onRetry)
                    .font(.scaled(size: 13, weight: .semibold))
                    .foregroundStyle(c.accentText)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 22)
        .padding(.horizontal, 14)
        .padding(.bottom, 2)
        .onChange(of: text) { _, next in
            AccessibilityNotification.Announcement(next).post()
        }
    }
}
