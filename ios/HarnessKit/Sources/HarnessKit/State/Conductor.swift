import Foundation

// Port of shared/src/state/conductor.ts: pure derivations for conductor tickets and their children
// (Children tab, board rollup, board dimming / hiding). No UI, no I/O.
//
// Ordering: TS reads ticket records with Object.values (insertion order) and sorts stably. Swift
// dictionaries are unordered, so `childrenOfTicket` breaks a full tie (same createdAt and position)
// by id, and `depStates` resolves two loaded tickets with the same upper-cased key to the one with
// the larger id. Both are ties the service doesn't produce.

/// A dependency of a ticket, resolved against the loaded tickets.
public struct DepState: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case done, pending, unknown
    }

    public var key: String
    public var done: Bool
    /// done / pending (loaded, not done) / unknown (not loaded: done tickets page in, so an unloaded
    /// dependency is usually an older done one; clients resolve it and the state settles). Render
    /// unknown neutrally, never as "waiting".
    public var state: Kind
    public var ticket: Ticket?
    /// The service said this key doesn't exist
    public var missing: Bool?

    public init(key: String, done: Bool, state: Kind, ticket: Ticket? = nil, missing: Bool? = nil) {
        self.key = key
        self.done = done
        self.state = state
        self.ticket = ticket
        self.missing = missing
    }
}

/// The slice of Web Storage the hide-children preference needs (localStorage on desktop; any sync
/// KV elsewhere, e.g. UserDefaults). Either call may throw (blocked storage); the preference then
/// falls back to its default.
public protocol KV {
    func getItem(_ key: String) throws -> String?
    func setItem(_ key: String, _ value: String) throws
}

public enum Conductor {
    public static func isChild(_ t: Ticket) -> Bool { t.parentId != nil }

    /// Why a ticket needs the human right now. Order = urgency.
    public enum Attention: String, Codable, Sendable, Equatable {
        case approval, blocked, review
    }

    /// A pending human review is the human's job only on top-level tickets. A conductor child's
    /// human review belongs to its conductor (it calls review_ticket), so a child needs the human
    /// only when it is blocked or waiting on a tool approval.
    public static func attentionOf(_ t: Ticket) -> Attention? {
        if t.pendingApproval != nil { return .approval }
        if t.status == .blocked { return .blocked }
        if t.status == .review, t.humanReview == .pending, !isChild(t) { return .review }
        return nil
    }

    public static func needsHuman(_ t: Ticket) -> Bool { attentionOf(t) != nil }

    /// Children are downplayed on the board so the conductor stays the focus, except when they
    /// need the human: those keep full weight wherever they are.
    public static func dimOnBoard(_ t: Ticket) -> Bool { isChild(t) && !needsHuman(t) }

    /// "Hide child tickets" never hides a child the human has to act on.
    public static func hideOnBoard(_ t: Ticket, hideChildren: Bool) -> Bool { hideChildren && dimOnBoard(t) }

    /// A conductor's children, oldest first (then by position).
    public static func childrenOfTicket(_ tickets: [String: Ticket], conductorId: String) -> [Ticket] {
        tickets.values
            .filter { $0.parentId == conductorId }
            .sorted { a, b in
                if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
                if a.position != b.position { return a.position < b.position }
                return a.id < b.id
            }
    }

    /// Whether a ticket's card shows the working spinner: its own agent has a run going, or (rolled
    /// up for a conductor) any ticket below it does, children and their children alike. A conductor
    /// whose children are all blocked, stopped or crashed stops spinning like any idle ticket. Walks
    /// up from each busy ticket rather than down from this one, since few tickets are busy at once.
    public static func isWorking(_ tickets: [String: Ticket], _ t: Ticket) -> Bool {
        if t.busy { return true }
        for b in tickets.values where b.busy {
            var seen: Set<String> = [b.id]
            var id = b.parentId
            while let cur = id, !cur.isEmpty, !seen.contains(cur) {
                if cur == t.id { return true }
                seen.insert(cur)
                id = tickets[cur]?.parentId
            }
        }
        return false
    }

    /// The spinner's accessibility label: whose work it stands for.
    public static func workingTitle(_ t: Ticket) -> String { t.busy ? "Agent working" : "A child ticket is working" }

    // MARK: Progress

    public struct Progress: Codable, Sendable, Equatable {
        public var total: Int
        public var byStatus: [TicketStatus: Int]
        /// Children needing the human (approval / blocked; their reviews are the conductor's)
        public var attention: Int

        public init(total: Int, byStatus: [TicketStatus: Int], attention: Int) {
            self.total = total
            self.byStatus = byStatus
            self.attention = attention
        }

        /// The count for a status (0 when none).
        public func count(_ status: TicketStatus) -> Int { byStatus[status] ?? 0 }

        enum CodingKeys: String, CodingKey { case total, byStatus, attention }

        // byStatus is a JSON object keyed by status, as in TS.
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            total = try c.decode(Int.self, forKey: .total)
            attention = try c.decode(Int.self, forKey: .attention)
            let raw = try c.decode([String: Int].self, forKey: .byStatus)
            byStatus = Dictionary(uniqueKeysWithValues: raw.map { (TicketStatus(rawValue: $0.key), $0.value) })
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(total, forKey: .total)
            try c.encode(Dictionary(uniqueKeysWithValues: byStatus.map { ($0.key.rawValue, $0.value) }), forKey: .byStatus)
            try c.encode(attention, forKey: .attention)
        }
    }

    /// Every known status starts at 0. (A status this build doesn't know is counted under its own
    /// key; TS ends up with NaN there. Neither shows in the label or the bar.)
    public static func progressOf(_ children: [Ticket]) -> Progress {
        var byStatus = Dictionary(uniqueKeysWithValues: TicketStatus.allKnown.map { ($0, 0) })
        var attention = 0
        for c in children {
            byStatus[c.status, default: 0] += 1
            if needsHuman(c) { attention += 1 }
        }
        return Progress(total: children.count, byStatus: byStatus, attention: attention)
    }

    /// "4/10 done · 2 in progress · 1 blocked · 1 review" (zero counts omitted, planning = "up next").
    public static func progressLabel(_ p: Progress) -> String {
        var parts = ["\(p.count(.done))/\(p.total) done"]
        if p.count(.inProgress) != 0 { parts.append("\(p.count(.inProgress)) in progress") }
        if p.count(.blocked) != 0 { parts.append("\(p.count(.blocked)) blocked") }
        if p.count(.review) != 0 { parts.append("\(p.count(.review)) review") }
        if p.count(.planning) != 0 { parts.append("\(p.count(.planning)) up next") }
        return parts.joined(separator: " · ")
    }

    /// Bar segments, left to right: done, review, in progress, blocked, planning. (SEGMENT_ORDER)
    public static let segmentOrder: [TicketStatus] = [.done, .review, .inProgress, .blocked, .planning]

    public struct Segment: Codable, Sendable, Equatable {
        public var status: TicketStatus
        public var count: Int
        /// Share of the total, 0–100
        public var pct: Double

        public init(status: TicketStatus, count: Int, pct: Double) {
            self.status = status
            self.count = count
            self.pct = pct
        }
    }

    /// The bar's segments in `segmentOrder`, empty ones dropped; none when there are no children.
    public static func progressSegments(_ p: Progress) -> [Segment] {
        guard p.total != 0 else { return [] }
        return segmentOrder.filter { p.count($0) > 0 }.map {
            Segment(status: $0, count: p.count($0), pct: (Double(p.count($0)) / Double(p.total)) * 100)
        }
    }

    // MARK: Dependencies

    /// `aliases`: old key (upper-case) → ticket id, for keys from before a project rename.
    public static func depStates(_ tickets: [String: Ticket], _ t: Ticket, aliases: [String: String] = [:]) -> [DepState] {
        var byKey: [String: Ticket] = [:]
        for x in tickets.values {
            let k = x.key.uppercased()
            if let seen = byKey[k], seen.id > x.id { continue }
            byKey[k] = x
        }
        return t.dependsOn.map { key in
            let upper = key.uppercased()
            var dep = byKey[upper]
            if dep == nil, let id = aliases[upper], !id.isEmpty { dep = tickets[id] }
            let state: DepState.Kind = dep == nil ? .unknown : dep!.status == .done ? .done : .pending
            return DepState(key: key, done: state == .done, state: state, ticket: dep)
        }
    }

    /// Chip tooltip: done, waiting, or not loaded / not found (never "waiting" for an unloaded key).
    public static func depChipTitle(_ d: DepState) -> String {
        switch d.state {
        case .done: "\(d.key) is done"
        case .pending: "Waiting on \(d.key)"
        case .unknown: d.missing == true ? "\(d.key) wasn't found" : "Looking up \(d.key)…"
        }
    }

    /// Keys still holding this ticket back (unknown keys count: gating must be conservative).
    public static func waitingOn(_ deps: [DepState]) -> [String] {
        deps.filter { !$0.done }.map(\.key)
    }

    /// Dependencies an auto-start ticket is waiting on: it was started (or created to start on its
    /// own) while they were open, so it sits in planning and the service starts it once they're
    /// done. Empty when it isn't waiting. Only loaded, unfinished dependencies count: an unknown key
    /// is usually an older done ticket, and the service treats a deleted one as done.
    public static func autoStartWaitingOn(_ t: Ticket, _ deps: [DepState]) -> [String] {
        guard t.draft != true, t.autoStart, t.status == .planning else { return [] }
        return deps.filter { $0.state == .pending }.map(\.key)
    }

    /// The waiting card's clock and the disabled Start button: "Starts on its own once A and B are done".
    public static func autoStartTitle(_ keys: [String]) -> String {
        guard let last = keys.last else { return "Starts on its own once its dependencies are done" }
        let list = keys.count > 1 ? "\(keys.dropLast().joined(separator: ", ")) and \(last)" : last
        return "Starts on its own once \(list) \(keys.count > 1 ? "are" : "is") done"
    }

    /// Depth in the sibling dependency graph, by upper-cased key: 0 = depends on no sibling, n = 1 +
    /// deepest sibling dep. Deps outside the set are ignored; cycles are cut (a ticket revisited
    /// mid-walk counts as 0).
    public static func dependencyDepths(_ children: [Ticket]) -> [String: Int] {
        var byKey: [String: Ticket] = [:]
        for c in children { byKey[c.key.uppercased()] = c }
        var depth: [String: Int] = [:]
        var walking = Set<String>()
        func visit(_ t: Ticket) -> Int {
            let k = t.key.uppercased()
            if let known = depth[k] { return known }
            if walking.contains(k) { return 0 }
            walking.insert(k)
            var d = 0
            for dep in t.dependsOn {
                if let sib = byKey[dep.uppercased()] { d = max(d, visit(sib) + 1) }
            }
            walking.remove(k)
            depth[k] = d
            return d
        }
        for c in children { _ = visit(c) }
        return depth
    }

    public struct ChildGroup: Sendable, Equatable {
        public var status: TicketStatus
        public var tickets: [Ticket]

        public init(status: TicketStatus, tickets: [Ticket]) {
            self.status = status
            self.tickets = tickets
        }
    }

    /// Children grouped by status in lifecycle (board) order, empty groups dropped. Within a group,
    /// attention first, then dependency order (a ticket after the siblings it waits on), then age.
    /// Full ties keep their input order (a stable sort, as in JS).
    public static func groupChildren(_ children: [Ticket]) -> [ChildGroup] {
        let depth = dependencyDepths(children)
        func rank(_ t: Ticket) -> Int { needsHuman(t) ? 0 : 1 }
        func d(_ t: Ticket) -> Int { depth[t.key.uppercased()] ?? 0 }
        return HarnessProtocol.ticketStatuses.map { status in
            let tickets = children.enumerated()
                .filter { $0.element.status == status }
                .sorted { x, y in
                    let a = x.element, b = y.element
                    if rank(a) != rank(b) { return rank(a) < rank(b) }
                    if d(a) != d(b) { return d(a) < d(b) }
                    if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
                    return x.offset < y.offset
                }
                .map(\.element)
            return ChildGroup(status: status, tickets: tickets)
        }
        .filter { !$0.tickets.isEmpty }
    }

    // MARK: Board preference

    // Child tickets are hidden unless the user shows them ("Show child tickets"), per device.
    // Stored "1" = hide, "0" = show; nothing stored (first run) = hide.
    // v2: the default flipped to hidden. Older builds stored "0" (shown), so a new key lets every
    // install pick up the new default once; toggling afterwards is remembered as before.

    /// HIDE_CHILDREN_KEY
    public static let hideChildrenKey = "harness.board.hideChildren.v2"
    /// HIDE_CHILDREN_DEFAULT
    public static let hideChildrenDefault = true

    /// The stored preference; the default when nothing (or garbage) is stored, there is no
    /// storage, or reading throws.
    public static func readHideChildren(_ storage: (any KV)?) -> Bool {
        do {
            switch try storage?.getItem(hideChildrenKey) {
            case "1"?: return true
            case "0"?: return false
            default: return hideChildrenDefault
            }
        } catch {
            return hideChildrenDefault
        }
    }

    /// Save the preference. A missing or throwing store is ignored (private mode / blocked
    /// storage: the toggle still works for this session).
    public static func writeHideChildren(_ value: Bool, _ storage: (any KV)?) {
        try? storage?.setItem(hideChildrenKey, value ? "1" : "0")
    }
}
