import Foundation

// The board screen's decisions that don't need a screen (the board, its cards and the Projects
// sheet): which column a first visit lands on, where search results jump, how the iPad's
// side-by-side columns are sized, when Done tops itself up, what a card's menu offers, what
// VoiceOver reads for a card, and the Projects sheet's open counts.

public enum BoardScreenRules {
    /// The first visit lands on the most useful column: what needs you, else what's moving.
    /// Nil when all four are empty (stay on the first column).
    public static func landingColumn(_ shown: Columns) -> TicketStatus? {
        [TicketStatus.blocked, .review, .inProgress, .planning].first { !shown[$0].isEmpty }
    }

    /// When search results land and `current` has none, the first column that does (nil: stay).
    public static func columnWithResults(_ shown: Columns, current: TicketStatus) -> TicketStatus? {
        columnWithResults(shown, visible: [current])
    }

    /// The same for the iPad's side-by-side columns: stay while any column on screen has results
    /// (or nothing is known to be on screen yet).
    public static func columnWithResults(_ shown: Columns, visible: Set<TicketStatus>) -> TicketStatus? {
        if visible.isEmpty || visible.contains(where: { !shown[$0].isEmpty }) { return nil }
        return TicketStatus.allKnown.first { !shown[$0].isEmpty }
    }

    // MARK: Layout

    /// How the board lays out its columns: the phone's one-column pager, or every column side by
    /// side (iPad at regular width).
    public enum Layout: Equatable, Sendable {
        case pager
        case columns
    }

    /// The narrowest a side-by-side column gets before the board scrolls sideways instead (the Mac's
    /// is 216): five fit an 11-inch iPad in landscape, not in portrait.
    public static let columnMinWidth: Double = 216
    /// The widest one gets (the Mac's is 380); a wider window leaves room at the trailing edge.
    public static let columnMaxWidth: Double = 400

    /// Side-by-side column sizing: `width` per column, and whether they overflow `available`.
    public struct ColumnSizing: Equatable, Sendable {
        public let width: Double
        public let scrolls: Bool
        public init(width: Double, scrolls: Bool) {
            self.width = width
            self.scrolls = scrolls
        }
    }

    /// Equal flexible widths that fill `available` (less `inset` on each side and `spacing` between),
    /// clamped to `min`…`max`. Below `min` the columns keep `min` and the board scrolls.
    public static func columnSizing(available: Double, count: Int = TicketStatus.allKnown.count, spacing: Double, inset: Double, min: Double = columnMinWidth, max: Double = columnMaxWidth) -> ColumnSizing {
        guard count > 0 else { return ColumnSizing(width: min, scrolls: false) }
        let fit = (available - 2 * inset - spacing * Double(count - 1)) / Double(count)
        if fit < min { return ColumnSizing(width: min, scrolls: true) }
        return ColumnSizing(width: Swift.min(fit, max), scrolls: false)
    }

    /// Whether to fetch another Done page unasked: hidden children can leave the loaded run nearly
    /// empty, so top it up while Done is on screen (the pager's page; any visible part of the
    /// side-by-side column). Never while searching, whose results page on their own.
    public static func shouldAutofillDone(_ layout: Layout, page: TicketStatus?, visible: Set<TicketStatus>, searching: Bool, visibleCount: Int, canLoad: Bool) -> Bool {
        if searching { return false }
        let onScreen = layout == .pager ? page == .done : visible.contains(.done)
        return onScreen && BoardLoader.shouldAutoFill(visibleCount: visibleCount, canLoad: canLoad)
    }

    /// One entry in a card's context menu, in menu order.
    public enum CardMenuItem: Equatable, Sendable {
        case discardDraft
        case move(TicketStatus)
        case moveTo(BoardColumns.Where)
        case openParent(key: String)
        case copyKey
    }

    /// A card's menu: a draft offers Discard and Copy key; any other card the other columns, top
    /// and bottom of its own (not Done, which is ordered by completion), its parent, and Copy key.
    public static func cardMenu(_ t: Ticket, parent: Ticket?) -> [CardMenuItem] {
        if t.draft == true { return [.discardDraft, .copyKey] }
        var out: [CardMenuItem] = TicketStatus.allKnown.filter { $0 != t.status }.map { .move($0) }
        if t.status != .done { out += [.moveTo(.top), .moveTo(.bottom)] }
        if let parent { out.append(.openParent(key: parent.key)) }
        out.append(.copyKey)
        return out
    }

    /// The card menu's title: "KEY · title" cut to 90 characters, or "KEY · Draft" for a draft.
    /// The cut applies to the whole line, key included.
    public static func menuTitle(_ t: Ticket) -> String {
        if t.draft == true { return "\(Keys.keyLabel(t)) · Draft" }
        return String("\(Keys.keyLabel(t)) · \(t.title)".prefix(90))
    }

    /// The statuses VoiceOver's custom actions move a card to (none for a draft).
    public static func accessibilityMoves(_ t: Ticket) -> [TicketStatus] {
        t.draft == true ? [] : TicketStatus.allKnown.filter { $0 != t.status }
    }

    /// What VoiceOver reads for a card (and what sim-check matches): "KEY title", plus why it
    /// matters when it's a draft, waiting on an approval, or blocked.
    public static func cardAccessibilityLabel(_ t: Ticket) -> String {
        let suffix = t.draft == true ? ", draft" : t.pendingApproval != nil ? ", needs approval" : t.status == .blocked ? ", blocked" : ""
        return "\(Keys.keyLabel(t)) \(t.title)\(suffix)"
    }

    /// The card's title line: its title, else a draft's first description line ("Empty draft").
    public static func cardTitle(_ t: Ticket) -> String {
        if !t.title.isEmpty { return t.title }
        guard t.draft == true else { return "Untitled" }
        // JS `split("\n")[0]` splits on the code unit, so "\r\n" keeps its "\r" (a Character split wouldn't split it at all).
        let scalars = t.description.unicodeScalars
        let first = String(String.UnicodeScalarView(scalars.prefix { $0 != "\n" }))
        return first.isEmpty ? "Empty draft" : first
    }

    /// Open (not done) tickets per project id, for the Projects sheet.
    public static func openCounts(_ tickets: some Sequence<Ticket>) -> [String: Int] {
        var m: [String: Int] = [:]
        for t in tickets where t.status != .done { m[t.projectId, default: 0] += 1 }
        return m
    }
}
