import Foundation

// The board screen's decisions that don't need a screen (the board, its cards and the Projects
// sheet): which column a first visit lands on, where search results jump, how the iPad's
// side-by-side columns are sized, when Done tops itself up, what a card's menu offers (the ticket's actions and Copy key), what
// VoiceOver reads for a card, and the Projects sheet's open counts.

public enum BoardScreenRules {
    /// The first visit lands on the most useful column: what needs you, else what's moving.
    /// Nil when all four are empty (stay on the first column).
    public static func landingColumn(_ shown: Columns) -> TicketStatus? {
        [TicketStatus.blocked, .review, .inProgress, .planning].first { !shown[$0].isEmpty }
    }

    /// The column a visit opens on: the one last viewed when it is a column the board has (every
    /// known status is one, shown empty or not; an unknown status has none), else the landing
    /// column. Nil when neither applies (stay on the first column).
    public static func openingColumn(remembered: TicketStatus?, shown: Columns) -> TicketStatus? {
        if let remembered, TicketStatus.allKnown.contains(remembered) { return remembered }
        return landingColumn(shown)
    }

    // MARK: Layout

    /// The board's layout: side by side at regular width (the iPad, a Plus or Pro Max in landscape),
    /// and on any phone in landscape, where one page-wide column would be far too wide; else the pager.
    public static func layout(regularWidth: Bool, compactHeight: Bool) -> Layout { regularWidth || compactHeight ? .columns : .pager }

    /// How the board lays out its columns: the phone's one-column pager, or every column side by
    /// side (iPad at regular width).
    public enum Layout: Equatable, Sendable {
        case pager
        case columns
    }

    /// Where the pager's column tabs go: the Duo's trailing margin, the top strip, or nowhere.
    public enum Tabs: Equatable, Sendable {
        /// Every column is on screen, so there is nothing to switch.
        case none
        /// A strip across the top (an ordinary phone, which has no margin to spare).
        case topStrip
        /// A vertical glass rail in the trailing margin (the Duo).
        case rail
    }

    /// The trailing safe-area margin that can hold the rail: wider than any phone's (a phone has none in
    /// portrait), narrower than the Duo's.
    public static let railMinMargin: Double = 40
    /// The margin that leaves room beside each icon for its count.
    public static let railCountsMinMargin: Double = 64

    /// Tabs follow the layout (only the pager needs them); the margin picks the rail over the strip.
    public static func tabs(layout: Layout, trailingMargin: Double) -> Tabs {
        guard layout == .pager else { return .none }
        return trailingMargin >= railMinMargin ? .rail : .topStrip
    }

    /// Whether the rail shows counts under its icons, by the margin it has.
    public static func railShowsCounts(trailingMargin: Double) -> Bool { trailingMargin >= railCountsMinMargin }

    /// The rail's outer width: the same as the system's bottom-bar buttons beside it (Projects, Search,
    /// CoS, New session), so the column of glass lines up.
    public static let railWidth: Double = 49
    /// The gap between the system's bottom-bar buttons and the screen's trailing edge on the Duo.
    public static let railTrailingGap: Double = 24
    /// The height the system's bottom-bar buttons take at the foot of the Duo's margin; the rail stays above it.
    public static let railBottomReserve: Double = 216
    private static let railPadding: Double = 4
    private static let railTabSpacing: Double = 2

    /// The tab height (and whether counts fit) for the room the rail has above the bottom-bar buttons:
    /// the roomiest size that fits, shrinking the tabs, then dropping counts, before it would run under them.
    public static func railTab(availableHeight: Double, wantsCounts: Bool, tabCount: Int) -> (height: Double, counts: Bool) {
        let sizes: [(Double, Bool)] = (wantsCounts ? [(46, true)] : []) + [(38, false), (32, false), (26, false)]
        let chrome = 2 * railPadding + railTabSpacing * Double(max(tabCount - 1, 0))
        return sizes.first { $0.0 * Double(tabCount) + chrome <= availableHeight } ?? sizes[sizes.count - 1]
    }

    /// A rail count: the number, capped at "99+" to fit the margin.
    public static func railCountLabel(_ n: Int) -> String { n > 99 ? "99+" : String(n) }

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
        /// One of the ticket's actions (TicketActions): the same ones its screen offers now.
        case ticket(TicketAction)
        case openParent(key: String)
        case copyKey
    }

    /// A card's menu: a draft offers Discard and Copy key; any other card the actions its ticket
    /// screen offers right now (the enabled ones: Start work, Approve, Request changes, Re-open,
    /// then the More menu's), its parent and Copy key. It never moves a card by itself: the actions
    /// ask the service, and agents do the moving.
    public static func cardMenu(_ t: Ticket, parent: Ticket?, project: Project? = nil, deps: [DepState] = [], settingsBaseBranch: String? = nil) -> [CardMenuItem] {
        if t.draft == true { return [.discardDraft, .copyKey] }
        var out = TicketActions.set(for: t, project: project, parent: parent, deps: deps, settingsBaseBranch: settingsBaseBranch)
            .enabledActions.map(CardMenuItem.ticket)
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

    /// What VoiceOver reads for a card (and what the UI tests match): "KEY title", plus why it
    /// matters when it's a draft, waiting on an approval, or blocked.
    public static func cardAccessibilityLabel(_ t: Ticket) -> String {
        let suffix = t.draft == true ? ", draft" : t.pendingApproval != nil ? ", needs approval" : t.status == .blocked ? ", blocked" : ""
        return "\(Keys.keyLabel(t)) \(t.title)\(suffix)"
    }

    /// The card's title line: its title, else a draft's first spec line ("Empty draft").
    public static func cardTitle(_ t: Ticket) -> String {
        if !t.title.isEmpty { return t.title }
        guard t.draft == true else { return "Untitled" }
        // JS `split("\n")[0]` splits on the code unit, so "\r\n" keeps its "\r" (a Character split wouldn't split it at all).
        let scalars = t.spec.unicodeScalars
        let first = String(String.UnicodeScalarView(scalars.prefix { $0 != "\n" }))
        return first.isEmpty ? "Empty draft" : first
    }

    /// Open (not done) tickets per project id, for the Projects sheet.
    public static func openCounts(_ tickets: some Sequence<Ticket>) -> [String: Int] {
        var m: [String: Int] = [:]
        for t in tickets where t.status != .done { m[t.projectId, default: 0] += 1 }
        return m
    }

    /// Open tickets per project group id (from `openCounts`), for the Projects sheet's group rows.
    public static func groupOpenCounts(_ counts: [String: Int], projects: some Sequence<Project>) -> [String: Int] {
        var m: [String: Int] = [:]
        for p in projects { if let g = p.groupId { m[g, default: 0] += counts[p.id] ?? 0 } }
        return m
    }
}
