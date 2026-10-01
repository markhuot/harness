import Foundation

// Port of shared/src/state/paging.ts: paged Done columns and server-side board search.
//
// Model
// - The snapshot loads every non-done ticket, plus the first page of done for the current board
//   scope. Other done tickets arrive by paging, search, ticket details (children, deps) and live
//   events, so `tickets` holds an arbitrary subset of done.
// - Paging is per scope (a project id, or `allScope` for "All projects"). The Done column shows a
//   contiguous prefix of the server's ordering (completedAt desc): done tickets at or after the
//   scope's `frontier` (the oldest completedAt paged in so far). Older done tickets that happen to
//   be loaded (a dependency, a search hit) stay out of the column until paging reaches them, so
//   "Load more" never reshuffles what's already on screen.
// - `total` is the server's count, kept current by live ticket.upserted / ticket.deleted events.
//
// How a client drives this: see BoardLoader (Done paging + debounced search) and BoardStore
// (snapshot on connect).

public enum Paging {
    public static let donePageSize = 50
    public static let searchPageSize = 50
    /// Search requests wait this long after the last keystroke (ms).
    public static let searchDebounceMs: Double = 200

    /// Paging scope key for "All projects".
    public static let allScope = "*"
    public static func scopeOf(_ projectId: String?) -> String {
        guard let projectId, !projectId.isEmpty else { return allScope }
        return projectId
    }
    /// The projectId to send for a scope (nil = all projects).
    public static func scopeProject(_ scope: String) -> String? { scope == allScope ? nil : scope }
    static func inScope(_ t: Ticket, _ scope: String) -> Bool { scope == allScope || t.projectId == scope }

    /// Every status the snapshot lists in full (all but done).
    public static let liveStatuses: [TicketStatus] = [.planning, .inProgress, .blocked, .review]

    /// When the ticket entered done; falls back to updatedAt for payloads without completedAt.
    public static func completedAtOf(_ t: Ticket) -> Timestamp { t.completedAt.optional ?? t.updatedAt }

    // MARK: Reducer pieces

    /// Merge fetched tickets into the map. A live event may have delivered a strictly newer
    /// version while the request was in flight; that one wins.
    public static func mergeTickets(_ existing: [String: Ticket], _ incoming: [Ticket]) -> [String: Ticket] {
        var next = existing
        for t in incoming {
            if let cur = next[t.id], cur.updatedAt > t.updatedAt { continue }
            next[t.id] = t
        }
        return next
    }

    /// Paging state after a done page arrives (append = a "Load more" page).
    public static func pagingFromPage(_ page: TicketPage, prev: DonePaging?, append: Bool) -> DonePaging {
        let times = page.tickets.map(completedAtOf)
        let oldest = times.min()
        let newestInPage = times.max()
        // Frontier only moves back: a later page's oldest ticket, or the previous one if it came back empty.
        let lower: Timestamp?
        if append, let pf = prev?.frontier {
            lower = oldest.map { min(pf, $0) } ?? pf
        } else {
            lower = oldest
        }
        return DonePaging(
            total: page.total,
            nextCursor: page.nextCursor,
            loading: false,
            frontier: page.nextCursor == nil ? nil : lower,
            newest: append && prev != nil ? prev!.newest : newestInPage,
            error: nil)
    }

    static func reduce(_ state: inout BoardState, _ action: BoardAction) {
        switch action {
        case let .donePageRequest(scope):
            if var prev = state.donePaging[scope] {
                prev.loading = true
                prev.error = nil
                state.donePaging[scope] = prev
            } else {
                state.donePaging[scope] = DonePaging(total: 0, nextCursor: nil, loading: true, frontier: nil, newest: nil, error: nil)
            }
        case let .donePage(scope, page, append, cursor):
            let prev = state.donePaging[scope]
            // A "Load more" page for a scope that was reset (reconnect snapshot) in the meantime is stale.
            if append && prev == nil { return }
            if append, let prev, cursor.isPresent, prev.nextCursor != cursor.optional { return }
            state.tickets = mergeTickets(state.tickets, page.tickets)
            state.donePaging[scope] = pagingFromPage(page, prev: prev, append: append)
        case let .donePageError(scope, error):
            guard var prev = state.donePaging[scope] else { return }
            prev.loading = false
            prev.error = error
            state.donePaging[scope] = prev
        case let .searchSet(raw, scope):
            let q = JSCompat.trim(raw)
            if q.isEmpty {
                state.search = nil
                return
            }
            if let s = state.search, s.q == q, s.scope == scope { return }
            state.search = SearchState(q: q, scope: scope, ids: nil, nextCursor: nil, total: 0, loading: true, error: nil)
        case let .searchRequest(q, scope):
            guard var s = state.search, s.q == JSCompat.trim(q), s.scope == scope else { return }
            s.loading = true
            s.error = nil
            state.search = s
        case let .searchResults(q, scope, page, append):
            // Out-of-order responses: only the current query's results count.
            guard var s = state.search, s.q == JSCompat.trim(q), s.scope == scope else { return }
            if append && s.ids == nil { return }
            let fresh = page.tickets.map(\.id)
            if append, let have = s.ids {
                s.ids = have + fresh.filter { !have.contains($0) }
            } else {
                s.ids = fresh
            }
            state.tickets = mergeTickets(state.tickets, page.tickets)
            s.nextCursor = page.nextCursor
            s.total = page.total
            s.loading = false
            s.error = nil
            state.search = s
        case let .searchError(q, scope, error):
            guard var s = state.search, s.q == JSCompat.trim(q), s.scope == scope else { return }
            s.loading = false
            s.error = error
            state.search = s
        default:
            break
        }
    }

    /// Keep done totals right across a live upsert (`next`) or delete (`next` = nil) of a ticket
    /// that was `prev` in the store (nil = not loaded).
    ///
    /// Unloaded tickets are the ambiguous case, resolved from what the snapshot guarantees (every
    /// non-done ticket is loaded):
    /// - unloaded and now done: already counted iff it was completed before the first page's newest
    ///   ticket (else it finished after the count and adds one);
    /// - unloaded and now not done: it existed at snapshot time (created no later than the newest
    ///   ticket the snapshot saw) so it must have been an unloaded done ticket that was reopened;
    ///   created later, it's brand new and was never counted.
    public static func adjustDoneTotals(_ state: BoardState, prev: Ticket?, next: Ticket?) -> [String: DonePaging] {
        guard !state.donePaging.isEmpty, let subject = next ?? prev else { return state.donePaging }
        var out = state.donePaging
        for (scope, p) in state.donePaging where inScope(subject, scope) {
            var delta = 0
            let isDone = next?.status == .done
            if let prev {
                let wasDone = prev.status == .done
                if wasDone && !isDone { delta = -1 } else if !wasDone && isDone { delta = 1 }
            } else if let next {
                if isDone {
                    delta = p.newest.map { completedAtOf(next) > $0 } ?? true ? 1 : 0
                } else if let asOf = state.ticketsAsOf, next.createdAt <= asOf {
                    delta = -1
                }
            }
            if delta == 0 { continue }
            var adjusted = p
            adjusted.total = max(0, p.total + delta)
            out[scope] = adjusted
        }
        return out
    }

    // MARK: Selectors

    /// The Done column for a scope: loaded done tickets in the paged-in prefix, newest completed
    /// first. Without paging state (an older service, or before the first page) every loaded done
    /// ticket in scope shows.
    public static func doneColumn(_ state: BoardState, _ projectId: String?) -> [Ticket] {
        let scope = scopeOf(projectId)
        let frontier = state.donePaging[scope]?.frontier
        return state.tickets.values
            .filter { t in t.status == .done && inScope(t, scope) && (frontier.map { completedAtOf(t) >= $0 } ?? true) }
            .sorted(by: newestCompletedFirst)
    }

    static func newestCompletedFirst(_ a: Ticket, _ b: Ticket) -> Bool {
        let d = completedAtOf(b) - completedAtOf(a)
        if d != 0 { return d < 0 }
        return JSString.less(a.id, b.id)
    }

    /// Board order for a live column: position, then age, then (Swift only, see BoardState.swift) id.
    static func boardOrder(_ a: Ticket, _ b: Ticket) -> Bool {
        if a.position != b.position { return a.position < b.position }
        if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
        return JSString.less(a.id, b.id)
    }

    /// Done count for the column header: the server's total when paging, else what's loaded.
    public static func doneCount(_ state: BoardState, _ projectId: String?, loaded: Int) -> Int {
        state.donePaging[scopeOf(projectId)]?.total ?? loaded
    }

    /// Whether the Done column has more to load (and isn't already loading it).
    public static func canLoadMoreDone(_ state: BoardState, _ projectId: String?) -> Bool {
        guard let p = state.donePaging[scopeOf(projectId)] else { return false }
        return p.nextCursor != nil && !p.loading
    }

    /// True when the scope needs its first done page (never requested, or reset by a snapshot).
    public static func needsFirstDonePage(_ state: BoardState, _ projectId: String?) -> Bool {
        state.ready && state.donePaging[scopeOf(projectId)] == nil
    }

    /// Instant local match while the server search is in flight: key (current or old), remote ID or title.
    public static func matchesQuery(_ t: Ticket, _ q: String, aliases: [String: String] = [:]) -> Bool {
        let needle = JSString.lower(JSCompat.trim(q))
        if needle.isEmpty { return true }
        if JSString.includes(JSString.lower(t.key), needle) || JSString.includes(JSString.lower(t.title), needle) { return true }
        if let ext = t.externalRef, JSString.includes(JSString.lower(ext.key), needle) { return true }
        for (alias, id) in aliases where id == t.id && JSString.includes(JSString.lower(alias), needle) { return true }
        return false
    }

    /// paging.ts sortColumns. TS sorts without an id tie-break, so equal keys keep their input
    /// order: server order for search results (kept here, Swift's sort is stable), dictionary order
    /// for local matches (broken by id here, see BoardState.swift).
    static func sortColumns(_ cols: inout Columns, tieById: Bool) {
        for status in TicketStatus.allKnown {
            cols[status].sort { a, b in
                let d = status == .done ? completedAtOf(b) - completedAtOf(a) : (a.position != b.position ? a.position - b.position : a.createdAt - b.createdAt)
                if d != 0 { return d < 0 }
                return tieById && JSString.less(a.id, b.id)
            }
        }
    }

    /// Board columns while a search is active. Server results once they land (each result in the
    /// column of its current status, so live moves still apply); until then, the loaded tickets
    /// that match locally. Search shows every match, child tickets included: the user is looking
    /// for something specific, and hiding a match would read as "not found".
    public static func searchColumns(_ state: BoardState, _ projectId: String?) -> (columns: Columns, pending: Bool) {
        var cols = Columns()
        guard let s = state.search else { return (cols, false) }
        guard let ids = s.ids else {
            let scope = scopeOf(projectId)
            for t in state.tickets.values where inScope(t, scope) && matchesQuery(t, s.q, aliases: state.keyAliases) {
                cols[t.status].append(t)
            }
            sortColumns(&cols, tieById: true)
            return (cols, true)
        }
        for id in ids {
            if let t = state.tickets[id] { cols[t.status].append(t) }
        }
        sortColumns(&cols, tieById: false)
        return (cols, false)
    }

    /// "Searching…", "No matches", "12 matches", "Showing 50 of 132 matches".
    public static func searchStatusText(_ s: SearchState) -> String {
        if let error = s.error { return "Search failed: \(error)" }
        guard let ids = s.ids else { return "Searching…" }
        if s.total == 0 { return "No matches" }
        if ids.count < s.total { return "Showing \(ids.count) of \(s.total) matches" }
        return "\(s.total) match\(s.total == 1 ? "" : "es")"
    }

    public static func canLoadMoreSearch(_ s: SearchState?) -> Bool {
        guard let s else { return false }
        return s.ids != nil && s.nextCursor != nil && !s.loading
    }
}
