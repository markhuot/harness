import HarnessKit
import SwiftUI

// What a docked ticket looks like minimized, the same on both platforms: a card in the dock and the
// expanded "N more…" list (DockedCard), plus the system menu a long press on the ticket's title shows
// in the iPad's panel (DockedTicketsMenuItems). A parked sheet (past
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

/// The other docked tickets as system menu items, for the context menu on a ticket's title (the
/// sheet's or the panel's ticket screen): the `Router.shownDockCount` most recently used, then
/// "N more" with the rest. Choosing one makes it the top, presented as the top was.
struct DockedTicketsMenuItems: View {
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app

    var body: some View {
        let state = app.store?.state
        let others = Array(router.dockedSheets.dropFirst())
        ForEach(others.prefix(Router.shownDockCount)) { row($0, state: state) }
        let overflow = Array(others.dropFirst(Router.shownDockCount))
        if !overflow.isEmpty {
            Menu("\(overflow.count) more") {
                ForEach(overflow) { row($0, state: state) }
            }
        }
    }

    private func row(_ sheet: TicketSheet, state: BoardState?) -> some View {
        Button(DockedTicketText(sheet, state: state, terminals: app.store?.terminals ?? []).menuLine) { router.activateSheet(id: sheet.id) }
    }
}

extension View {
    /// A long press shows the other docked tickets to switch to, while this screen is in the iPad's
    /// ticket panel and more than one ticket is docked.
    func dockedTicketsMenu(_ router: Router, inSheet: Bool) -> some View {
        modifier(DockedTicketsContextMenu(enabled: inSheet && router.dockedSheets.count > 1))
    }
}

private struct DockedTicketsContextMenu: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.contextMenu { DockedTicketsMenuItems() }
        } else {
            content
        }
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
        case .newSession, .file, .terminal: break
        }
        if let top = sheet.topTicketKey, !out.contains(top) { out.append(top) }
        return out
    }
}

/// Where and how a DockedCardsContainer lays its cards: the platform's placement and policy, which
/// are all that differs between the iPhone's dock and the iPad's corner stack.
struct DockedCardsLayout {
    enum Edge { case bottom, trailing }

    /// The room the dock has: the window on the phone, the board's column left of the panel on the iPad.
    var region: CGSize
    var alignment: Alignment
    var columnAlignment: HorizontalAlignment
    var insets: EdgeInsets
    /// Nil: as wide as the room (the phone).
    var cardWidth: CGFloat?
    /// The "N docked…" card alone holds every ticket (an iPad column with no room for a card).
    var collapsed = false
    /// Nothing shows (an iPad column too narrow even for that).
    var hidden = false
    var listWidth: CGFloat?
    /// The tallest the expanded list gets; nil fills the room.
    var listHeightCap: CGFloat?
    var maxVisible: Int
    var fitting: Int?
    var edge: Edge
    var backdropAnchor: UnitPoint
    var backdropRadius: CGFloat
    /// The backdrop and its tap-catcher cover `region` rather than the whole screen.
    var backdropFillsRegion: Bool
    /// The hold-to-dock ghost takes an incoming bottom slot (the phone's; the iPad's ghost is the panel host's).
    var ghostSlot = false

    static let margin = DockMetrics.cornerMargin

    /// Full width above the ticket, in from the sides as far as the board's bottom bar.
    static func phone(screen: ConcentricBar.Screen?, region: CGSize) -> DockedCardsLayout {
        let sides = DockMetrics.phoneSides(screen: screen)
        return DockedCardsLayout(
            region: region, alignment: .bottom, columnAlignment: .center,
            insets: EdgeInsets(top: 0, leading: sides, bottom: DockMetrics.phoneBottomGap, trailing: sides),
            cardWidth: nil, listWidth: nil, listHeightCap: nil, maxVisible: DockCards.phoneVisible, fitting: nil,
            edge: .bottom, backdropAnchor: .bottom, backdropRadius: region.height * 1.1, backdropFillsRegion: false,
            ghostSlot: true)
    }

    /// The board's bottom-right corner, in the column `available` wide.
    static func pad(available: CGSize) -> DockedCardsLayout {
        var layout = DockedCardsLayout(
            region: available, alignment: .bottomTrailing, columnAlignment: .trailing,
            insets: EdgeInsets(top: margin, leading: margin, bottom: margin, trailing: margin),
            cardWidth: nil, listWidth: nil, listHeightCap: available.height - margin * 2,
            maxVisible: DockCards.padVisible, fitting: DockMetrics.rowsFitting(height: available.height),
            edge: .trailing, backdropAnchor: .bottomTrailing, backdropRadius: max(available.width, available.height) * 0.9,
            backdropFillsRegion: true)
        switch DockMetrics.cardMode(width: available.width) {
        case let .cards(width):
            layout.cardWidth = width
            layout.listWidth = width
        case let .collapsed(width):
            layout.cardWidth = width
            layout.collapsed = true
            layout.listWidth = max(width, min(DockMetrics.maxCardWidth, available.width - margin * 2))
        case .hidden:
            layout.hidden = true
        }
        return layout
    }

    /// The rows (cards and "N more…") `count` docked tickets take.
    func rows(count: Int) -> Int {
        if hidden { return 0 }
        if collapsed { return count > 0 ? 1 : 0 }
        return DockCards.rows(count: count, maxVisible: maxVisible, fitting: fitting)
    }

    /// The collapsed stack's height for `count` docked tickets, for the board's bottom clearance.
    func stackHeight(count: Int) -> CGFloat { DockedCardMetrics.stackHeight(rows: rows(count: count)) }
}

/// What a DockedCardsContainer tells its host: where its collapsed stack is in the window (nil with
/// no cards) and whether the list is open over the whole screen.
struct DockedCardsReport: Equatable {
    var stack: CGRect?
    var expanded: Bool
}

/// The docked tickets as cards, the same on both platforms: newest at the bottom, up to the layout's
/// `maxVisible` (fewer when the height doesn't fit them), then "N more…", which expands a scrolling list
/// of them all on a blurred backdrop. A tap opens a card in the sheet (or panel) and its ✕ closes it
/// (a file holding unsaved edits asks first). Cards insert and remove by id, so switching tickets
/// animates only the cards that change; the container itself is never torn down or slid away with
/// them. The iPhone hosts it in a window of its own above the board and the ticket sheet
/// (DockWindow); the iPad hosts it over the board beside the panel (TicketPanelHost).
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
        ZStack(alignment: layout.alignment) {
            if expanded, !layout.hidden {
                backdrop
            }
            if !layout.hidden {
                cards.padding(layout.insets)
                    .accessibilityAddTraits(expanded ? .isModal : [])
            }
            if layout.ghostSlot {
                DockGhostCard(title: ghost ?? "", armed: ghost != nil)
                    .padding(layout.insets)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .snappy, value: sheets.map(\.id))
        .animation(.snappy, value: expanded)
        // Nothing left to expand: back to the cards.
        .onChange(of: sheets.count) { _, n in if n <= layout.maxVisible, !layout.collapsed { expanded = false } }
        .onChange(of: sheets.isEmpty) { _, empty in
            if empty { expanded = false; stack = nil }
        }
        .onChange(of: shown) { _, shown in if !shown { expanded = false } }
        .onChange(of: docked) { _, docked in if docked { focused = sheets.first?.id } }
        .onChange(of: report, initial: true) { _, report in onReport(report) }
    }

    private var report: DockedCardsReport {
        DockedCardsReport(stack: sheets.isEmpty || layout.hidden ? nil : stack, expanded: expanded)
    }

    /// Behind the list: blurred out of the corner, and a tap there collapses it.
    @ViewBuilder private var backdrop: some View {
        if layout.backdropFillsRegion {
            DockedBackdrop(anchor: layout.backdropAnchor, radius: layout.backdropRadius)
                .frame(width: layout.region.width, height: layout.region.height)
                .transition(.opacity)
            Color.clear
                .frame(width: layout.region.width, height: layout.region.height)
                .contentShape(.rect)
                .onTapGesture { expanded = false }
                .accessibilityHidden(true)
        } else {
            DockedBackdrop(anchor: layout.backdropAnchor, radius: layout.backdropRadius)
            Color.clear
                .contentShape(.rect)
                .ignoresSafeArea()
                .onTapGesture { expanded = false }
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder private var cards: some View {
        if expanded {
            list
        } else if layout.collapsed {
            if !sheets.isEmpty {
                DockedMoreCard(count: sheets.count, all: true) { expanded = true }
                    .frame(width: layout.cardWidth)
            }
        } else if !sheets.isEmpty {
            // Not an empty stack for no cards: it would still cost the VStack's gap.
            collapsedStack
        }
    }

    private var cardTransition: AnyTransition {
        if reduceMotion { return .opacity }
        return .move(edge: layout.edge == .bottom ? .bottom : .trailing).combined(with: .opacity)
    }

    private var collapsedStack: some View {
        let split = DockCards.split(count: sheets.count, maxVisible: layout.maxVisible, fitting: layout.fitting)
        let lift = ghost != nil ? DockedCardMetrics.height + DockedCardMetrics.spacing : 0
        return VStack(alignment: layout.columnAlignment, spacing: DockedCardMetrics.spacing) {
            if split.more > 0 {
                DockedMoreCard(count: split.more) { expanded = true }
                    .frame(width: layout.cardWidth)
            }
            // Oldest at the top, newest at the bottom.
            ForEach(sheets.prefix(split.cards).reversed()) { sheet in
                DockedCard(sheet: sheet, open: { open(sheet) }, close: { closeCard(sheet) })
                    .frame(width: layout.cardWidth)
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

    private var list: some View {
        // As tall as its cards, up to the room it has; past that it scrolls.
        let list = DockedCardList(sheets: sheets, open: open, close: { closeCard($0) }, collapse: { expanded = false })
        return Group {
            if let cap = layout.listHeightCap {
                let natural = 20 + 40 + DockedCardMetrics.spacing + DockedCardMetrics.stackHeight(rows: sheets.count)
                list.frame(width: layout.listWidth, height: min(natural, cap))
                    .transition(.scale(scale: 0.9, anchor: .bottomTrailing).combined(with: .opacity))
            } else {
                list.frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
            }
        }
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
