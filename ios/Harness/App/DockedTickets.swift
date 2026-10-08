import HarnessKit
import SwiftUI

// What a docked ticket looks like minimized, the same on both platforms: a card in the iPhone's
// dock, the iPad's corner stack and the expanded "N more…" list (DockedCard), plus the system menu
// a long press on the ticket's title shows (DockedTicketsMenuItems). A parked sheet (past
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

    @MainActor init(_ sheet: TicketSheet, state: BoardState?) {
        if let key = sheet.topTicketKey {
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
    var menuLine: String { [ref, title].compactMap { $0 }.joined(separator: " · ") }

    /// VoiceOver's name for it, and sim-check's: "<ref>, <title>, docked".
    var accessibilityLabel: String { [ref, title, "docked"].compactMap { $0 }.joined(separator: ", ") }
}

/// The ref and title on one line: the ref whole, the title truncated into whatever room is left.
struct DockedTicketLabel: View {
    let sheet: TicketSheet
    var refFont: Font = .headline
    var titleFont: Font = .subheadline
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var c

    var body: some View {
        let text = DockedTicketText(sheet, state: app.store?.state)
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

/// A docked ticket minimized: its status dot (the board's colors; a pencil for New session), ref
/// and truncated title, and an ✕ that takes just it off the dock. A tap anywhere else opens it.
/// `glass` gives it its own floating capsule (the iPad's corner); without it it's a row on the
/// surface it sits on (the iPhone's docked sheet, the expanded list).
struct DockedCard: View {
    let sheet: TicketSheet
    var height: CGFloat = 52
    var glass = false
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
                    DockedTicketLabel(sheet: sheet, refFont: .subheadline.weight(.semibold), titleFont: .subheadline)
                }
                .padding(.leading, 16)
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
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(c.text3)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 4)
            .accessibilityLabel("Close \(sheet.title)")
            .accessibilityIdentifier("ticket-dock-close")
        }
        .frame(height: height)
        .modifier(CardSurface(glass: glass))
    }

    @ViewBuilder private func statusIcon(_ text: DockedTicketText) -> some View {
        if text.isNewSession {
            Image(systemName: "square.and.pencil")
                .font(.caption.weight(.bold))
                .foregroundStyle(c.accent)
                .frame(width: 12)
        } else if let status = text.status {
            StatusDot(status: status, size: 9).frame(width: 12)
        } else {
            Circle().strokeBorder(c.text3, lineWidth: 1.5).frame(width: 9, height: 9).frame(width: 12)
        }
    }
}

/// The card on top of the visible ones when more are docked than show: "N more…" and a stack icon.
/// It expands the list of them all.
struct DockedMoreCard: View {
    let count: Int
    var height: CGFloat = 52
    var glass = false
    /// Its label says how many in all rather than how many more (the iPad's lone card, where no
    /// card fits beside the panel).
    var all = false
    let expand: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        Button(action: expand) {
            HStack(spacing: 10) {
                Text(all ? "\(count) docked…" : "\(count) more…")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(c.text)
                Spacer(minLength: 8)
                Image(systemName: "square.stack")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(c.text2)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .frame(height: height)
        .modifier(CardSurface(glass: glass))
        .accessibilityLabel(all ? "\(count) docked tickets" : "\(count) more docked tickets")
        .accessibilityHint("Double-tap to list them all")
        .accessibilityIdentifier("ticket-dock-more")
    }
}

/// Every docked ticket as a card, most recently used first, scrolling past the height it's given:
/// what "N more…" expands into. A header names the count and collapses it again.
struct DockedCardList: View {
    /// The list's natural height for `count` cards: the header, the cards, their dividers.
    static func height(count: Int, cardHeight: CGFloat = 52) -> CGFloat { 44 + 8 + CGFloat(count) * (cardHeight + 1) }

    let sheets: [TicketSheet]
    let open: (TicketSheet) -> Void
    let close: (TicketSheet) -> Void
    let collapse: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(sheets.count) docked")
                    .font(.headline)
                    .foregroundStyle(c.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button(action: collapse) {
                    Image(systemName: "chevron.down")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(c.text2)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Collapse docked tickets")
                .accessibilityIdentifier("ticket-dock-collapse")
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(sheets) { sheet in
                        DockedCard(sheet: sheet, open: { open(sheet) }, close: { close(sheet) })
                        Divider().padding(.leading, 16)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ticket-dock-list")
    }
}

/// A card's own floating surface, or none.
private struct CardSurface: ViewModifier {
    let glass: Bool

    func body(content: Content) -> some View {
        if glass {
            content
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16))
                .shadow(color: .black.opacity(0.18), radius: 10, x: -2, y: 2)
        } else {
            content
        }
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
        Button(DockedTicketText(sheet, state: state).menuLine) { router.activateSheet(id: sheet.id) }
    }
}

extension View {
    /// A long press shows the other docked tickets to switch to, while this screen is in the ticket
    /// sheet or panel and more than one ticket is docked.
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
        case .newSession: break
        }
        if let top = sheet.topTicketKey, !out.contains(top) { out.append(top) }
        return out
    }
}

/// The iPad's docked tickets as cards in the board's bottom-right corner, newest at the bottom:
/// every sheet while docked, the ones behind the panel while it's open. Up to
/// `DockCards.padVisible`, fewer when the height doesn't fit them, then "N more…", which expands a
/// scrolling list of them all up to the window's height. A tap opens one in the panel; its ✕ closes
/// it. It keeps to the board's column (never over the sidebar): where that's too narrow for a
/// useful card, the "N more…" card alone holds them all, and where even that won't fit, nothing
/// shows (the title's long-press menu still lists them).
struct DockedCardStack: View {
    /// What the stack lists, most recently used first.
    let sheets: [TicketSheet]
    /// The room it has: the board's column left of the panel.
    let available: CGSize
    @Environment(Router.self) private var router
    @State private var expanded = false

    static let cardHeight: CGFloat = 52
    static let spacing: CGFloat = 8
    static let margin: CGFloat = 16
    static let maxWidth: CGFloat = 320
    /// The narrowest card worth showing: the ref and a few words of title.
    static let minWidth: CGFloat = 200
    /// The room a lone "N more…" card needs, margins included.
    static let collapsedRoom: CGFloat = 150

    enum Mode: Equatable {
        /// Cards this wide.
        case cards(CGFloat)
        /// The "N more…" card alone, this wide, holding every docked ticket.
        case collapsed(CGFloat)
        case hidden
    }

    /// What fits a column `width` wide.
    static func mode(width: CGFloat) -> Mode {
        let room = width - margin * 2
        if room >= minWidth { return .cards(min(maxWidth, room)) }
        return width >= collapsedRoom ? .collapsed(room) : .hidden
    }

    /// How many rows (cards and "N more…") fit `height`.
    static func fitting(height: CGFloat) -> Int {
        max(1, Int((height - margin * 2 + spacing) / (cardHeight + spacing)))
    }

    /// The stack's height for `count` docked tickets, for the board's bottom clearance.
    static func height(count: Int, available: CGSize) -> CGFloat {
        let rows: Int
        switch mode(width: available.width) {
        case .hidden: rows = 0
        case .collapsed: rows = count > 0 ? 1 : 0
        case .cards: rows = DockCards.rows(count: count, maxVisible: DockCards.padVisible, fitting: fitting(height: available.height))
        }
        return CGFloat(rows) * cardHeight + CGFloat(max(0, rows - 1)) * spacing
    }

    var body: some View {
        let mode = Self.mode(width: available.width)
        Group {
            switch mode {
            case let .cards(width):
                if expanded { list(width: width) } else { stack(width: width) }
            case let .collapsed(width):
                if expanded {
                    list(width: max(width, min(Self.maxWidth, available.width - Self.margin * 2)))
                } else {
                    DockedMoreCard(count: sheets.count, height: Self.cardHeight, glass: true, all: true) { expanded = true }
                        .frame(width: width)
                }
            case .hidden:
                EmptyView()
            }
        }
        .padding(Self.margin)
        .animation(.snappy, value: sheets.map(\.id))
        .animation(.snappy, value: expanded)
        // Nothing left to expand: back to the cards.
        .onChange(of: sheets.count) { _, n in if n <= DockCards.padVisible, case .cards = mode { expanded = false } }
        .onChange(of: sheets.isEmpty) { _, empty in if empty { expanded = false } }
    }

    private func stack(width: CGFloat) -> some View {
        let split = DockCards.split(count: sheets.count, maxVisible: DockCards.padVisible, fitting: Self.fitting(height: available.height))
        return VStack(alignment: .trailing, spacing: Self.spacing) {
            if split.more > 0 {
                DockedMoreCard(count: split.more, height: Self.cardHeight, glass: true) { expanded = true }
                    .frame(width: width)
            }
            // Oldest at the top, newest at the bottom.
            ForEach(sheets.prefix(split.cards).reversed()) { sheet in
                DockedCard(sheet: sheet, height: Self.cardHeight, glass: true,
                           open: { open(sheet) }, close: { router.closeSheet(id: sheet.id) })
                    .frame(width: width)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
    }

    private func list(width: CGFloat) -> some View {
        DockedCardList(sheets: sheets, open: open, close: { router.closeSheet(id: $0.id) }, collapse: { expanded = false })
            .padding(.vertical, 4)
            // As tall as its cards, up to the window's height; past that it scrolls.
            .frame(width: width, height: min(DockedCardList.height(count: sheets.count), available.height - Self.margin * 2))
            .glassEffect(.regular, in: .rect(cornerRadius: 20))
            .shadow(color: .black.opacity(0.18), radius: 12, x: -2, y: 2)
            .transition(.scale(scale: 0.9, anchor: .bottomTrailing).combined(with: .opacity))
    }

    private func open(_ sheet: TicketSheet) {
        expanded = false
        router.activateSheet(id: sheet.id)
        router.restoreDock()
    }
}
