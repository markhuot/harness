import HarnessKit
import SwiftUI

// What a docked ticket looks like collapsed, the same on both platforms: the iPhone's dock bar and
// its switcher menu, the expanded sheet's toolbar menu, and the iPad's pill stack. A parked sheet
// (past `Router.liveSheetCount`) is only ever drawn this way, from the board's own `Ticket`.

/// A docked sheet's ref and title, read from the `Ticket` the board's card renders
/// (`BoardState.tickets`), never a copy of its own. A key the board doesn't have yet shows the ref
/// alone; New session shows "New session" with its draft's title when it has one.
struct DockedTicketText: Equatable {
    var ref: String
    var title: String?

    @MainActor init(_ sheet: TicketSheet, state: BoardState?) {
        if let key = sheet.topTicketKey {
            let ticket = state?.ticketByKey(key)
            ref = ticket.map { Keys.displayKey($0) } ?? key
            title = ticket?.title
        } else {
            ref = "New session"
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

/// The docked tickets as a menu: the `Router.shownDockCount` most recently used, then "+N more" with
/// the rest. The dock bar's lists them all, the top checked; `othersOnly` (the expanded sheet's
/// toolbar) leaves out the ticket on screen. Choosing one makes it the top, docked or presented as
/// the top was; `then` runs after.
struct DockedTicketsMenu<Label: View>: View {
    var othersOnly = false
    var then: () -> Void = {}
    @ViewBuilder let label: () -> Label
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app

    var body: some View {
        Menu {
            let state = app.store?.state
            let listed = othersOnly ? Array(router.dockedSheets.dropFirst()) : router.dockedSheets
            ForEach(listed.prefix(Router.shownDockCount)) { row($0, state: state, isTop: $0.id == router.dockedSheets.first?.id) }
            let overflow = Array(listed.dropFirst(Router.shownDockCount))
            if !overflow.isEmpty {
                Menu("\(overflow.count) more") {
                    ForEach(overflow) { row($0, state: state, isTop: false) }
                }
                .accessibilityIdentifier("ticket-dock-more")
            }
        } label: {
            label()
        }
        // As listed, whichever way it opens: the most recent first, "N more" last.
        .menuOrder(.fixed)
    }

    private func row(_ sheet: TicketSheet, state: BoardState?, isTop: Bool) -> some View {
        let text = DockedTicketText(sheet, state: state)
        return Button {
            router.activateSheet(id: sheet.id)
            then()
        } label: {
            // One line rather than a title and subtitle, which keeps rows as short as the system
            // allows; it still wraps a long title to three lines, and a long list scrolls.
            if isTop { SwiftUI.Label(text.menuLine, systemImage: "checkmark") } else { Text(text.menuLine) }
        }
    }
}

/// The stack button: the docked tickets' count, opening `DockedTicketsMenu` (`othersOnly` in the
/// expanded sheet's toolbar).
struct DockedTicketsButton: View {
    var othersOnly = false
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        let count = router.dockedSheets.count
        DockedTicketsMenu(othersOnly: othersOnly) {
            HStack(spacing: 3) {
                Image(systemName: "square.stack")
                Text("\(count)").monospacedDigit()
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(c.text2)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        }
        .accessibilityLabel("\(count) docked tickets")
        .accessibilityIdentifier("ticket-dock-switcher")
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

/// The iPad's docked tickets, waiting in the board's bottom-right corner as a stack of pills,
/// newest at the bottom: every sheet while docked, the ones behind the panel while it's open.
/// At most `Router.shownDockCount`, fewer when the height doesn't fit them, then a "+N" pill with
/// the rest in a menu. A tap opens one in the panel; its context menu closes it. It keeps to the
/// board's column (never over the sidebar): where that's too narrow for a useful pill, one "+N"
/// pill holds them all, and where even that won't fit, nothing shows (the panel's toolbar menu
/// still lists them).
struct DockedPillStack: View {
    /// What the stack lists, most recently used first.
    let sheets: [TicketSheet]
    /// The room it has: the board's column left of the panel.
    let available: CGSize
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var c

    static let pillHeight: CGFloat = 44
    static let spacing: CGFloat = 8
    static let margin: CGFloat = 16
    static let maxWidth: CGFloat = 320
    /// The narrowest pill worth showing: the ref and a few words of title.
    static let minWidth: CGFloat = 200
    /// The room a lone "+N" pill needs, margins included.
    static let collapsedRoom: CGFloat = 96

    enum Mode: Equatable {
        /// Pills this wide.
        case pills(CGFloat)
        /// One "+N" pill with every docked ticket in its menu.
        case collapsed
        case hidden
    }

    /// What fits a column `width` wide.
    static func mode(width: CGFloat) -> Mode {
        let room = width - margin * 2
        if room >= minWidth { return .pills(min(maxWidth, room)) }
        return width >= collapsedRoom ? .collapsed : .hidden
    }


    /// How many pills (the "+N" one included) fit `height`.
    static func fitting(height: CGFloat) -> Int {
        max(1, Int((height - margin * 2 + spacing) / (pillHeight + spacing)))
    }

    /// The pills shown and how many are left for "+N": up to `shownDockCount`, and with the "+N"
    /// pill as many as fit `height`.
    static func split(count: Int, height: CGFloat) -> (shown: Int, overflow: Int) {
        let fit = fitting(height: height)
        let cap = min(Router.shownDockCount, count)
        if cap == count, count <= fit { return (count, 0) }
        let shown = max(0, min(cap, fit - 1))
        return (shown, count - shown)
    }

    /// The stack's height for `sheets`, for the board's bottom clearance.
    static func height(count: Int, available: CGSize) -> CGFloat {
        guard count > 0 else { return 0 }
        switch mode(width: available.width) {
        case .hidden: return 0
        case .collapsed: return pillHeight
        case .pills: break
        }
        let split = split(count: count, height: available.height)
        let pills = split.shown + (split.overflow > 0 ? 1 : 0)
        return CGFloat(pills) * pillHeight + CGFloat(max(0, pills - 1)) * spacing
    }

    var body: some View {
        let split = Self.split(count: sheets.count, height: available.height)
        VStack(alignment: .trailing, spacing: Self.spacing) {
            switch Self.mode(width: available.width) {
            case let .pills(width):
                let shown = Array(sheets.prefix(split.shown))
                let rest = Array(sheets.dropFirst(split.shown))
                if !rest.isEmpty { more(rest, all: false) }
                // Oldest at the top, newest at the bottom.
                ForEach(shown.reversed()) { pill($0, width: width) }
            case .collapsed:
                more(sheets, all: true)
            case .hidden:
                EmptyView()
            }
        }
        .padding(Self.margin)
        .animation(.snappy, value: sheets.map(\.id))
    }

    private func pill(_ sheet: TicketSheet, width: CGFloat) -> some View {
        let text = DockedTicketText(sheet, state: app.store?.state)
        return Button {
            router.activateSheet(id: sheet.id)
            router.restoreDock()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: sheet.topTicketKey == nil ? "square.and.pencil" : "rectangle.stack")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(c.accent)
                DockedTicketLabel(sheet: sheet, refFont: .subheadline.weight(.semibold), titleFont: .subheadline)
            }
            .padding(.horizontal, 16)
            .frame(width: width, height: Self.pillHeight)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .shadow(color: .black.opacity(0.18), radius: 10, x: -2, y: 2)
        .contentShape(.contextMenuPreview, .capsule)
        .contextMenu {
            Button("Close", systemImage: "xmark", role: .destructive) { router.closeSheet(id: sheet.id) }
        }
        .transition(.move(edge: .trailing).combined(with: .opacity))
        .accessibilityLabel(text.accessibilityLabel)
        .accessibilityHint("Double-tap to open")
        .accessibilityIdentifier("ticket-dock")
        .accessibilityAction(named: "Close") { router.closeSheet(id: sheet.id) }
    }

    /// "+N": the sheets past the pills (or `all` of them, where no pill fits), in a menu.
    private func more(_ rest: [TicketSheet], all: Bool) -> some View {
        Menu {
            let state = app.store?.state
            ForEach(rest) { sheet in
                let text = DockedTicketText(sheet, state: state)
                Button {
                    router.activateSheet(id: sheet.id)
                    router.restoreDock()
                } label: {
                    Text(text.menuLine)
                }
            }
        } label: {
            Text("+\(rest.count)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(c.text)
                .monospacedDigit()
                .padding(.horizontal, 18)
                .frame(height: Self.pillHeight)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .shadow(color: .black.opacity(0.18), radius: 10, x: -2, y: 2)
        .accessibilityLabel(all ? "\(rest.count) docked tickets" : "\(rest.count) more docked tickets")
        .accessibilityIdentifier("ticket-dock-more")
    }
}
