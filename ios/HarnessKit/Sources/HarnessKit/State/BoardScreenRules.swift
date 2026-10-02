import Foundation

// The board screen's decisions that don't need a screen (mobile/src/screens/Board.tsx,
// TicketCard.tsx, Projects.tsx): which column a first visit lands on, where search results jump,
// what a card's menu offers, what VoiceOver reads for a card, where a dragged card goes, and the
// Projects sheet's open counts.

public enum BoardScreenRules {
    /// The first visit lands on the most useful column: what needs you, else what's moving.
    /// Nil when all four are empty (stay on the first column).
    public static func landingColumn(_ shown: Columns) -> TicketStatus? {
        [TicketStatus.blocked, .review, .inProgress, .planning].first { !shown[$0].isEmpty }
    }

    /// When search results land and `current` has none, the first column that does (nil: stay).
    public static func columnWithResults(_ shown: Columns, current: TicketStatus) -> TicketStatus? {
        if !shown[current].isEmpty { return nil }
        return TicketStatus.allKnown.first { !shown[$0].isEmpty }
    }

    /// One entry in a card's context menu, in the RN action sheet's order.
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

    /// The card menu's title (the RN action sheet's): "KEY · title" cut to 90 characters, or
    /// "KEY · Draft" for a draft. RN cuts the whole line, key included.
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

    /// The update for dropping `t` into `status` just above the card `beforeId` (nil: at the end).
    /// `cols` is the unfiltered board, so hidden children keep their place around the drop. Nil when
    /// nothing would change (dropped where it already is). Done is ordered by completion, so a
    /// drop there sends no position.
    public static func dropMove(_ t: Ticket, to status: TicketStatus, before beforeId: String?, cols: Columns, now: Timestamp = Date().timeIntervalSince1970 * 1000) -> BoardColumns.Move? {
        if beforeId == t.id { return nil }
        let column = cols[status]
        let others = column.filter { $0.id != t.id }
        let index = beforeId.flatMap { id in others.firstIndex { $0.id == id } } ?? others.count
        // Inserting a card back at its own index (in the column without it) leaves the order as is.
        let inPlace = t.status == status && column.firstIndex { $0.id == t.id } == index
        let position = status == .done || inPlace ? nil : BoardState.positionForDrop(others, index: index)
        let body = BoardColumns.Move.Body(status: t.status != status ? status : nil, position: position)
        if body.status == nil && body.position == nil { return nil }
        let completedAt: Patch<Timestamp> = t.status == status ? t.completedAt : status == .done ? .value(now) : .null
        return BoardColumns.Move(body: body, completedAt: completedAt)
    }

    /// Open (not done) tickets per project id, for the Projects sheet.
    public static func openCounts(_ tickets: some Sequence<Ticket>) -> [String: Int] {
        var m: [String: Int] = [:]
        for t in tickets where t.status != .done { m[t.projectId, default: 0] += 1 }
        return m
    }
}
