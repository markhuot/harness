import Foundation

// Port of the selector half of shared/src/state/reducer.ts. Where TS returns tickets in object
// insertion order, Swift sorts (see BoardState.swift).

extension BoardState {
    /// The project's tickets (every project when nil), by id.
    public func ticketsForProject(_ projectId: String?) -> [Ticket] {
        tickets.values.filter { projectId == nil || $0.projectId == projectId }.sorted { JSString.less($0.id, $1.id) }
    }

    /// The board: live columns by position then age, Done newest-completed first and only the
    /// paged-in prefix (Paging.doneColumn).
    public func boardColumns(_ projectId: String?) -> Columns {
        var cols = Columns()
        for t in tickets.values where (projectId == nil || t.projectId == projectId) && t.status != .done {
            cols[t.status].append(t)
        }
        for status in Paging.liveStatuses { cols[status].sort(by: Paging.boardOrder) }
        cols.done = Paging.doneColumn(self, projectId)
        return cols
    }

    /// By current key, else by an old key (from before a project rename) the service resolved for us.
    public func ticketByKey(_ key: String) -> Ticket? {
        let upper = JSString.upper(key)
        if let direct = tickets.values.filter({ JSString.upper($0.key) == upper }).min(by: { JSString.less($0.id, $1.id) }) {
            return direct
        }
        return keyAliases[upper].flatMap { tickets[$0] }
    }

    /// Whether markdown should link a ticket-shaped word (FOO-12) to the ticket: it's loaded, or its
    /// prefix is a project's key (done tickets aren't all in memory; the detail fetches it). Keys the
    /// service already 404'd, and look-alikes such as UTF-8, stay plain text.
    public func ticketLinkable(_ key: String) -> Bool {
        let upper = JSString.upper(key)
        if missingKeys[upper] == true { return false }
        if ticketByKey(upper) != nil { return true }
        // upper.slice(0, upper.lastIndexOf("-")): no dash → slice(0, -1) drops the last code unit.
        let units = Array(upper.utf16)
        let dash = units.lastIndex(of: 0x2D) ?? (units.count - 1)
        let prefix = String(decoding: units[0..<max(0, dash)], as: UTF16.self)
        return projects.values.contains { JSString.upper($0.key) == prefix }
    }

    /// Triage sessions, newest first.
    public func triageSessions() -> [Session] {
        sessions.values.filter { $0.kind == .triage }.sorted { a, b in
            a.createdAt != b.createdAt ? a.createdAt > b.createdAt : JSString.less(a.id, b.id)
        }
    }

    /// The driver new tickets in a project get: the project's own default, else the global one (nil until settings load).
    public func defaultDriverOf(_ projectId: String) -> String? {
        projects[projectId]?.defaultDriver ?? settings?.defaultDriver
    }

    /// Whether a ticket runs on something other than its project's default driver, i.e. worth labelling.
    public func hasCustomDriver(_ ticket: Ticket) -> Bool {
        guard let d = defaultDriverOf(ticket.projectId) else { return false }
        return ticket.driver != d
    }

    /// A conductor's children, oldest first.
    public func childrenOf(_ ticketId: String) -> [Ticket] {
        tickets.values.filter { $0.parentId == ticketId }.sorted { a, b in
            a.createdAt != b.createdAt ? a.createdAt < b.createdAt : JSString.less(a.id, b.id)
        }
    }

    /// Conductors on hand whose child list may be partial (no detail yet): fetch their details.
    public func conductorsNeedingChildren() -> [Ticket] {
        guard ready else { return [] }
        return tickets.values.filter { $0.isConductor && childrenLoaded[$0.id] != true }.sorted { JSString.less($0.id, $1.id) }
    }

    /// Tickets that depend on this one: the detail's list (covers done ones that aren't loaded)
    /// merged with a live scan of the store (covers ones added since). Unloaded keys come back
    /// without a ticket.
    public func dependentsOf(_ ticket: Ticket) -> [Dependent] {
        let me = JSString.upper(ticket.key)
        var out: [String: Dependent] = [:]
        var order: [String] = []
        func put(_ key: String, _ d: Dependent) {
            if out[key] == nil { order.append(key) }
            out[key] = d
        }
        for t in tickets.values.sorted(by: { JSString.less($0.id, $1.id) }) where t.dependsOn.contains(where: { JSString.upper($0) == me }) {
            put(JSString.upper(t.key), Dependent(key: t.key, ticket: t))
        }
        for k in dependents[ticket.id] ?? [] {
            let t = ticketByKey(k)
            if let t, !t.dependsOn.contains(where: { JSString.upper($0) == me }) { continue } // no longer depends on it
            let key = JSString.upper(t?.key ?? k)
            if out[key] == nil { put(key, Dependent(key: t?.key ?? k, ticket: t)) }
        }
        return order.compactMap { out[$0] }.sorted { BoardState.numericLess($0.key, $1.key) }
    }

    /// The session's newest Activity entry, or with `kinds` the newest of those kinds.
    public func latestActivity(_ sessionId: String, kinds: [ActivityKind]? = nil) -> ActivityEntry? {
        let list = activity[sessionId] ?? []
        guard let kinds else { return list.last }
        return list.last { kinds.contains($0.kind) }
    }

    /// The body of a ticket's spec revision when it's known: the current one from the ticket
    /// itself, an earlier one once fetched (`.specRevision`). nil means fetch it.
    public func specBody(_ ticketId: String, rev: Int) -> String? {
        if let t = tickets[ticketId], (t.specRevision ?? 1) == rev { return t.spec }
        return specBodies[Self.specBodyKey(ticketId, rev)]
    }

    /// In-flight text for a session (normally one run at a time), by run id.
    public func liveDelta(_ sessionId: String) -> [LiveDelta] {
        (deltas[sessionId] ?? [:]).map { LiveDelta(runId: $0.key, text: $0.value) }.sorted { JSString.less($0.runId, $1.runId) }
    }

    /// Projects by name.
    public func sortedProjects() -> [Project] {
        projects.values.sorted { a, b in
            let c = BoardState.localeCompare(a.name, b.name)
            return c != .orderedSame ? c == .orderedAscending : JSString.less(a.id, b.id)
        }
    }

    /// Which project the composer should target: the current choice if it still exists, else the
    /// first candidate (route project, last used) that exists, else the first project by name.
    /// A picker renders its first option even when its value matches nothing, so the composer must
    /// never hold an id that isn't a real project.
    public func composerProject(_ current: String, candidates: [String?]) -> String {
        if !current.isEmpty, projects[current] != nil { return current }
        if let c = candidates.compactMap({ $0 }).first(where: { !$0.isEmpty && projects[$0] != nil }) { return c }
        return sortedProjects().first?.id ?? ""
    }

    /// `isReady`: in review with both reviews passed.
    public static func isReady(_ t: Ticket) -> Bool {
        t.status == .review && HarnessProtocol.reviewPassed(t.agentReview) && t.humanReview == .approved
    }

    /// Position for a ticket dropped at `index` in a column (`column` in display order, without the
    /// dragged ticket). Positions are REALs server-side, so we take the midpoint of the neighbours.
    public static func positionForDrop(_ column: [Double], index: Int) -> Double {
        let i = max(0, min(index, column.count))
        let before = i > 0 ? column[i - 1] : nil
        let after = i < column.count ? column[i] : nil
        switch (before, after) {
        case (nil, nil): return 0
        case let (nil, a?): return a - 1
        case let (b?, nil): return b + 1
        case let (b?, a?):
            // Equal neighbours (legacy data) can't be split; nudge just above the earlier one.
            return a > b ? (b + a) / 2 : b + 1e-6
        }
    }

    public static func positionForDrop(_ column: [Ticket], index: Int) -> Double {
        positionForDrop(column.map(\.position), index: index)
    }

    // MARK: Collation

    /// `a.localeCompare(b)` (ICU root collation in JS engines; Foundation's localized compare here).
    static func localeCompare(_ a: String, _ b: String) -> ComparisonResult {
        a.compare(b, options: [], range: nil, locale: Locale(identifier: "en_US"))
    }

    /// `a.localeCompare(b, undefined, { numeric: true }) < 0`
    static func numericLess(_ a: String, _ b: String) -> Bool {
        let c = a.compare(b, options: [.numeric], range: nil, locale: Locale(identifier: "en_US"))
        return c != .orderedSame ? c == .orderedAscending : JSString.less(a, b)
    }
}

/// A ticket that depends on another (`dependentsOf`); `ticket` is nil when it isn't loaded.
public struct Dependent: Codable, Sendable, Equatable {
    public var key: String
    public var ticket: Ticket?
    public init(key: String, ticket: Ticket? = nil) {
        self.key = key
        self.ticket = ticket
    }
}

/// One run's streamed text (`liveDelta`).
public struct LiveDelta: Codable, Sendable, Equatable {
    public var runId: String
    public var text: String
    public init(runId: String, text: String) {
        self.runId = runId
        self.text = text
    }
}
