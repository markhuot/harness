import HarnessKit
import SwiftUI

// What a docked ticket looks like minimized, the same on both platforms: a card in the dock and the
// expanded "N more…" list (DockedCard). A parked sheet (past
// `Router.liveSheetCount`) is only ever drawn this way, from the board's own `Ticket`.

/// A docked sheet's ref, title and status, read from the `Ticket` the board's card renders
/// (`BoardState.tickets`), never a copy of its own. A key the board doesn't have yet shows the ref
/// alone; New session shows "New session" with its draft's title when it has one.
struct DockedTicketText: Equatable {
    var ref: String
    var title: String?
    /// The ticket's status; nil for New session or a ticket the board doesn't have yet.
    var status: TicketStatus?
    var isNewSession = false
    var isFile = false
    var isTerminal = false

    @MainActor init(_ sheet: TicketSheet, state: BoardState?, terminals: [TerminalInfo] = []) {
        if let id = sheet.terminalID {
            // A terminal: what it is (its title, else its program) and where it is; "ended" once it's gone.
            isTerminal = true
            if let t = terminals.first(where: { $0.id == id }) {
                ref = TerminalList.label(t)
                title = TerminalList.subtitle(t)
            } else {
                ref = "Terminal"
                title = "ended"
            }
        } else if let scope = sheet.cosScope {
            // A chief of staff: what it covers, "All projects" or its group.
            ref = "Chief of Staff"
            title = CosLogic.title(scope: scope, groupName: state?.projectGroups().first { CosLogic.scopeKey(groupId: $0.id) == scope }?.name)
        } else if let file = sheet.file {
            // A file: its name, and the ticket or project it's in.
            ref = FileViewerRules.fileName(file.path)
            isFile = true
            if let key = file.ticket {
                title = key
            } else if let id = file.project {
                title = state?.projects[id]?.name
            } else {
                title = nil
            }
        } else if let key = sheet.topTicketKey {
            let ticket = state?.ticketByKey(key)
            ref = ticket.map { Keys.displayKey($0) } ?? key
            title = ticket?.title
            status = ticket?.status
        } else {
            ref = "New session"
            isNewSession = true
            if case let .newSession(_, key?) = sheet.root { title = state?.ticketByKey(key)?.title } else { title = nil }
        }
        if title?.isEmpty == true { title = nil }
    }

    /// A menu row's one line: "<ref> · <title>", the system truncating the title.
    var menuLine: String { DockLabels.menuLine(ref: ref, title: title) }

    /// VoiceOver's name for it, and the UI tests': "<ref>, <title>, docked".
    var accessibilityLabel: String { DockLabels.accessibilityLabel(ref: ref, title: title) }
}

/// The ref and title on one line: the ref whole, the title truncated into whatever room is left.
struct DockedTicketLabel: View {
    let sheet: TicketSheet
    var refFont: Font = .headline
    var titleFont: Font = .subheadline
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var c

    var body: some View {
        let text = DockedTicketText(sheet, state: app.store?.state, terminals: app.store?.terminals ?? [])
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(text.ref)
                .font(refFont)
                .monospacedDigit()
                .foregroundStyle(c.text)
                .lineLimit(1)
                .fixedSize()
                .layoutPriority(1)
            if let title = text.title {
                Text(title)
                    .font(titleFont)
                    .foregroundStyle(c.text2)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The size every minimized card shares, on both platforms: the height the single docked sheet
/// had, and the gap between cards.
typealias DockedCardMetrics = DockMetrics

/// A docked ticket minimized: its own fully rounded glass capsule, as the single docked sheet was,
/// with its status dot (the board's colors; a pencil for New session), ref and truncated title, and
/// an ✕ that takes just it off the dock. A tap anywhere else opens it. Without `glass` it's the
/// same card on a glass it sits on: the iPhone's docked sheet, which is the top card.
struct DockedCard: View {
    let sheet: TicketSheet
    var glass = true
    let open: () -> Void
    let close: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var c

    var body: some View {
        let text = DockedTicketText(sheet, state: app.store?.state)
        HStack(spacing: 0) {
            Button(action: open) {
                HStack(spacing: 10) {
                    statusIcon(text)
                    DockedTicketLabel(sheet: sheet)
                }
                .padding(.leading, 22)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(text.accessibilityLabel)
            .accessibilityHint("Double-tap to open")
            .accessibilityIdentifier("ticket-dock")
            .accessibilityAction(named: "Close", close)
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(c.text3)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding(.trailing, DockedCard.closeInset)
            .accessibilityLabel("Close \(sheet.title)")
            .accessibilityIdentifier("ticket-dock-close")
        }
        .frame(height: DockedCardMetrics.height)
        .modifier(CapsuleGlass(on: glass))
    }

    /// From the ✕'s tap target to the capsule's trailing edge.
    static let closeInset = DockMetrics.closeInset

    @ViewBuilder private func statusIcon(_ text: DockedTicketText) -> some View {
        if text.isTerminal {
            Image(systemName: "terminal")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(c.text2)
                .frame(width: 14)
        } else if text.isFile {
            Image(systemName: "doc.text")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(c.text2)
                .frame(width: 14)
        } else if text.isNewSession {
            Image(systemName: "square.and.pencil")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(c.accent)
                .frame(width: 14)
        } else if let status = text.status {
            StatusDot(status: status, size: 10).frame(width: 14)
        } else {
            Circle().strokeBorder(c.text3, lineWidth: 1.5).frame(width: 10, height: 10).frame(width: 14)
        }
    }
}

/// A card's own glass capsule, or none when it sits on one.
private struct CapsuleGlass: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        if on {
            content.glassEffect(.regular.interactive(), in: .capsule).contentShape(.capsule)
        } else {
            content.contentShape(.rect)
        }
    }
}

/// The card on top of the visible ones when more are docked than show, in the same glass capsule:
/// "N more…" and a stack icon. It expands the list of them all.
struct DockedMoreCard: View {
    let count: Int
    /// Its label says how many in all rather than how many more (the iPad's lone card, where no
    /// card fits beside the panel).
    var all = false
    let expand: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        Button(action: expand) {
            HStack(spacing: 10) {
                Text(all ? "\(count) docked…" : "\(count) more…")
                    .font(.headline)
                    .monospacedDigit()
                    .foregroundStyle(c.text)
                    .lineLimit(1)
                    .fixedSize()
                Spacer(minLength: 8)
                Image(systemName: "square.stack")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(c.text2)
            }
            .padding(.leading, 22)
            .padding(.trailing, 22)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .frame(height: DockedCardMetrics.height)
        .glassEffect(.regular.interactive(), in: .capsule)
        .accessibilityLabel(DockMetrics.moreLabel(count: count, all: all))
        .accessibilityHint("Double-tap to list them all")
        .accessibilityIdentifier("ticket-dock-more")
    }
}

/// Every docked ticket as its own glass card, the most recent at the bottom like the dock, scrolled
/// to the bottom and scrolling up past the height it's given: what "N more…" expands into. No
/// background of its own: it sits on a DockedBackdrop. A small capsule on top collapses it again.
struct DockedCardList: View {
    let sheets: [TicketSheet]
    /// How many are docked in all, for the header (the iPhone lists all but the top, whose card is
    /// the docked sheet below the list).
    var total: Int?
    let open: (TicketSheet) -> Void
    let close: (TicketSheet) -> Void
    let collapse: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        GeometryReader { g in
        ScrollView {
            VStack(alignment: .trailing, spacing: DockedCardMetrics.spacing) {
                Button(action: collapse) {
                    Label("\(total ?? sheets.count) docked", systemImage: "chevron.down")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(c.text)
                        .padding(.horizontal, 16)
                        .frame(height: 40)
                        .contentShape(.capsule)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .capsule)
                .accessibilityLabel("Collapse docked tickets")
                .accessibilityIdentifier("ticket-dock-collapse")
                // Oldest at the top, the most recent at the bottom, nearest the thumb.
                ForEach(sheets.reversed()) { sheet in
                    DockedCard(sheet: sheet, open: { open(sheet) }, close: { close(sheet) })
                }
            }
            // Below the top edge's fade.
            .padding(.top, 20)
            // A short list sits at the bottom, just above the dock; a long one scrolls.
            .frame(maxWidth: .infinity, minHeight: g.size.height, alignment: .bottomTrailing)
        }
        .defaultScrollAnchor(.bottom)
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
        // Cards scrolling up fade out at the list's top edge rather than run under the status bar;
        // the mask reaches past the other edges so the glass keeps its rim and shadow there.
        .mask {
            VStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 20)
                Rectangle()
            }
            .padding(.horizontal, -24)
            .padding(.bottom, -24)
        }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ticket-dock-list")
    }
}

/// What sets the expanded list apart from what's behind it, in place of a background: a large
/// radial progressive blur rising out of `anchor` (the iPhone's bottom, the iPad's bottom-right
/// corner), blurred and tinted most at the anchor and clear at its far edge.
struct DockedBackdrop: View {
    let anchor: UnitPoint
    let radius: CGFloat
    @Environment(\.palette) private var c

    var body: some View {
        ZStack {
            // Progressive: the blur's strength follows the mask, strongest at the anchor.
            Rectangle()
                .fill(.regularMaterial)
                .mask(RadialGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.35),
                                             .init(color: .black.opacity(0.6), location: 0.65), .init(color: .clear, location: 1)],
                                     center: anchor, startRadius: 0, endRadius: radius))
            RadialGradient(stops: [.init(color: c.bg.opacity(0.55), location: 0), .init(color: c.bg.opacity(0.25), location: 0.6),
                                   .init(color: .clear, location: 1)],
                           center: anchor, startRadius: 0, endRadius: radius)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Keeps every docked ticket resolved on the board (`BoardStore.watchKey`), so a parked one's row
/// has its title even when it's a done ticket the board hasn't paged in, and drops the sheets of
/// tickets the server says are gone (`BoardState.missingKeys`), as `Router.removeTicket` does for a
/// deleted one. Goes inside the store's environment.
struct DockedTicketsKeeper: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(BoardStore.self) private var store
    @State private var releases: [String: @MainActor () -> Void] = [:]

    func body(content: Content) -> some View {
        let keys = Set(router.dockedSheets.flatMap(Self.keys))
        content
            .onChange(of: keys, initial: true) { _, keys in
                for (key, release) in releases where !keys.contains(key) {
                    release()
                    releases[key] = nil
                }
                for key in keys where releases[key] == nil { releases[key] = store.watchKey(key) }
            }
            .onChange(of: store.state.missingKeys, initial: true) { _, missing in
                let gone = keys.filter { missing[$0.uppercased()] == true }
                guard !gone.isEmpty else { return }
                // One screen per sheet per pass; a sheet whose root is gone goes in one.
                var passes = 0
                while passes < 64, router.removeTicket(where: { gone.contains($0) }) { passes += 1 }
            }
            .onDisappear {
                releases.values.forEach { $0() }
                releases = [:]
            }
    }

    /// The tickets a sheet keeps resolved: its root's, the one on top, and New session's draft.
    private static func keys(_ sheet: TicketSheet) -> [String] {
        var out: [String] = []
        switch sheet.root {
        case let .ticket(key, _): out.append(key)
        case let .newSession(_, key?): out.append(key)
        case .newSession, .file, .terminal, .cos: break
        }
        if let top = sheet.topTicketKey, !out.contains(top) { out.append(top) }
        return out
    }
}

/// Where a DockedCardsContainer lays its cards: over the bar the cards float above (the board's
/// system bar, the ticket's composer), at the gaps its `placement` gives.
struct DockedCardsLayout {
    /// The room the dock has: the window.
    var region: CGSize
    var insets: EdgeInsets
    var maxVisible = DockCards.phoneVisible

    static func phone(placement: DockPlacement, region: CGSize) -> DockedCardsLayout {
        DockedCardsLayout(
            region: region,
            insets: EdgeInsets(top: 0, leading: placement.leading, bottom: placement.bottom, trailing: placement.trailing))
    }

    /// The backdrop's radius: the blur spreads from the bottom edge.
    var backdropRadius: CGFloat { region.height * 1.1 }
}

/// What a DockedCardsContainer tells its host: where its collapsed stack is in the window (nil with
/// no cards) and whether the list is open over the whole screen.
struct DockedCardsReport: Equatable {
    var stack: CGRect?
    var expanded: Bool
}

/// The docked tickets as cards: newest at the bottom, up to the layout's `maxVisible + 1`; with
/// more, `maxVisible` and "N more…", which expands a scrolling list of them all on a blurred
/// backdrop. A tap opens a card in the sheet and its ✕ closes it
/// (a file holding unsaved edits asks first). Cards insert and remove by id, so switching tickets
/// animates only the cards that change; the container itself is never torn down or slid away with
/// them. It lives in a window of its own above the board and the ticket sheet (DockWindow), at every
/// width.
struct DockedCardsContainer: View {
    /// What it lists, most recently used first (`Router.waitingSheets`).
    let sheets: [TicketSheet]
    let layout: DockedCardsLayout
    /// The title the hold-to-dock ghost shows in the incoming bottom slot while a release will dock;
    /// the other cards lift one row to make room.
    var ghost: String?
    /// The top ticket was just docked: VoiceOver lands on its card, as the sheet it left is gone.
    var docked = false
    /// False while the dock is hidden (a sheet, a keyboard, a dialog): an open list closes rather than
    /// reopening when the dock comes back.
    var shown = true
    var onReport: (DockedCardsReport) -> Void = { _ in }
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @State private var stack: CGRect?
    @AccessibilityFocusState private var focused: Int?

    var body: some View {
        ZStack(alignment: .bottom) {
            if expanded {
                backdrop
            }
            cards.padding(layout.insets)
                .accessibilityAddTraits(expanded ? .isModal : [])
            DockGhostCard(title: ghost ?? "", armed: ghost != nil)
                .padding(layout.insets)
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .snappy, value: sheets.map(\.id))
        .animation(.snappy, value: expanded)
        // Nothing left to expand: back to the cards.
        .onChange(of: sheets.count) { _, n in if n <= layout.maxVisible + 1 { expanded = false } }
        .onChange(of: sheets.isEmpty) { _, empty in
            if empty { expanded = false; stack = nil }
        }
        .onChange(of: shown) { _, shown in if !shown { expanded = false } }
        .onChange(of: docked) { _, docked in if docked { focused = sheets.first?.id } }
        .onChange(of: report, initial: true) { _, report in onReport(report) }
    }

    private var report: DockedCardsReport {
        DockedCardsReport(stack: sheets.isEmpty ? nil : stack, expanded: expanded)
    }

    /// Behind the list: blurred out of the bottom edge, and a tap there collapses it.
    @ViewBuilder private var backdrop: some View {
        DockedBackdrop(anchor: .bottom, radius: layout.backdropRadius)
        Color.clear
            .contentShape(.rect)
            .ignoresSafeArea()
            .onTapGesture { expanded = false }
            .accessibilityHidden(true)
    }

    @ViewBuilder private var cards: some View {
        if expanded {
            DockedCardList(sheets: sheets, open: open, close: { closeCard($0) }, collapse: { expanded = false })
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity)
        } else if !sheets.isEmpty {
            // Not an empty stack for no cards: it would still cost the VStack's gap.
            collapsedStack
        }
    }

    private var cardTransition: AnyTransition {
        if reduceMotion { return .opacity }
        return .move(edge: .bottom).combined(with: .opacity)
    }

    private var collapsedStack: some View {
        let split = DockCards.split(count: sheets.count, maxVisible: layout.maxVisible, fitting: nil)
        let lift = ghost != nil ? DockedCardMetrics.height + DockedCardMetrics.spacing : 0
        return VStack(alignment: .center, spacing: DockedCardMetrics.spacing) {
            if split.more > 0 {
                DockedMoreCard(count: split.more) { expanded = true }
            }
            // Oldest at the top, newest at the bottom.
            ForEach(sheets.prefix(split.cards).reversed()) { sheet in
                DockedCard(sheet: sheet, open: { open(sheet) }, close: { closeCard(sheet) })
                    .accessibilityFocused($focused, equals: sheet.id)
                    .transition(cardTransition)
            }
        }
        // Measured before the lift: the stack's own place. Not while the list is open, which rises
        // over the page rather than asking it to make room, nor while the ghost lifts it.
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
            if !expanded, ghost == nil { stack = frame }
        }
        .offset(y: -lift)
        .animation(.snappy(duration: 0.2), value: lift)
    }

    /// ✕ on a card. A file whose save failed as it went to the dock holds its edits
    /// (`UnsavedEdits`) with nothing mounted to ask about them: it comes forward instead, with the
    /// edits and the failure showing, and its own Close asks.
    private func closeCard(_ sheet: TicketSheet) {
        if case let .file(params) = sheet.root, let root = FileViewer.readFileParams(params)?.root,
           let path = FileViewer.readFileParams(params)?.path, UnsavedEdits.shared.has(root, path: path) {
            open(sheet)
        } else {
            withAnimation(.snappy) { router.closeSheet(id: sheet.id) }
        }
    }

    /// A tap: the ticket becomes the top, and the sheet is presented if it was docked. While one is
    /// presented it swaps in place.
    private func open(_ sheet: TicketSheet) {
        expanded = false
        withAnimation(.snappy) {
            router.activateSheet(id: sheet.id)
            router.restoreDock()
        }
    }
}
