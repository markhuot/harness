import Foundation

// Port of shared/src/state/reducer.ts and paging.ts (types): REST snapshots + live HarnessEvents →
// one normalized state tree. Pure values, no I/O; BoardStore does the wiring.
//
// Named BoardState / BoardAction (TS: State / Action) so app code that imports both HarnessKit
// and SwiftUI never has to disambiguate `@State`.
//
// Entity maps are Swift dictionaries, which have no order, where TS objects iterate in insertion
// order. Every selector that TS sorts sorts the same way here; where TS leaves equal sort keys in
// insertion order, Swift breaks the tie by id (JS string order), and selectors whose TS output
// order is insertion order (unresolvedKeys, conductorsNeedingChildren, ticketsForProject) are
// sorted by key/id. Fixture tests compare those as sets.

public struct TranscriptState: Codable, Sendable, Equatable {
    public var entries: [TranscriptEntry]
    /// True once the REST backfill has been merged in
    public var loaded: Bool

    public init(entries: [TranscriptEntry] = [], loaded: Bool = false) {
        self.entries = entries
        self.loaded = loaded
    }
}

/// Done paging per board scope (paging.ts DonePaging).
public struct DonePaging: Codable, Sendable, Equatable {
    /// Server count of done tickets in this scope, adjusted by live events since
    public var total: Int
    /// Cursor for the next page; null once every done ticket in the scope is loaded
    @Nullable public var nextCursor: String?
    /// A page request is in flight
    public var loading: Bool
    /// completedAt of the oldest paged-in ticket; null = no lower bound (everything is loaded)
    @Nullable public var frontier: Timestamp?
    /// completedAt of the newest ticket in the first page (null when the scope had none). A done
    /// ticket we haven't seen, completed after this, was finished after the count was taken.
    @Nullable public var newest: Timestamp?
    @Nullable public var error: String?

    public init(total: Int, nextCursor: String?, loading: Bool, frontier: Timestamp?, newest: Timestamp?, error: String?) {
        self.total = total
        self.nextCursor = nextCursor
        self.loading = loading
        self.frontier = frontier
        self.newest = newest
        self.error = error
    }
}

/// The board's server-side search (paging.ts SearchState).
public struct SearchState: Codable, Sendable, Equatable {
    /// The trimmed query
    public var q: String
    public var scope: String
    /// Matching ticket ids in server order; null until the first page for this q/scope lands
    @Nullable public var ids: [String]?
    @Nullable public var nextCursor: String?
    public var total: Int
    public var loading: Bool
    @Nullable public var error: String?

    public init(q: String, scope: String, ids: [String]?, nextCursor: String?, total: Int, loading: Bool, error: String?) {
        self.q = q
        self.scope = scope
        self.ids = ids
        self.nextCursor = nextCursor
        self.total = total
        self.loading = loading
        self.error = error
    }
}

public struct BoardState: Codable, Sendable, Equatable {
    public var connected: Bool
    /// True after the first full snapshot has been applied
    public var ready: Bool
    public var projects: [String: Project]
    public var tickets: [String: Ticket]
    public var sessions: [String: Session]
    public var runs: [String: Run]
    /// Keyed by sessionId, sorted by createdAt, unique by id
    public var summaries: [String: [Summary]]
    /// Keyed by `transcriptKey(sessionId, subagentId)`: the session agent's transcript under the
    /// session id, each sub-agent's under "<sessionId>/<subagentId>". Sorted by seq, unique by id.
    public var transcripts: [String: TranscriptState]
    /// Sub-agents per sessionId, oldest first (from the ticket detail + subagent.upserted)
    public var subagents: [String: [Subagent]]
    /// In-flight streaming assistant text: deltas[sessionId][runId]
    public var deltas: [String: [String: String]]
    public var watchers: [String: Watcher]
    @Nullable public var settings: PublicSettings?
    public var drivers: [DriverInfo]
    /// Done paging per board scope (project id or `Paging.allScope`); see Paging.swift
    public var donePaging: [String: DonePaging]
    /// The board's server-side search, when the filter box has a query
    @Nullable public var search: SearchState?
    /// Old ticket keys (upper-case, from before a project rename) → ticket id
    public var keyAliases: [String: String]
    /// Keys the service answered 404 for (so they aren't refetched until the next snapshot)
    public var missingKeys: [String: Bool]
    /// Conductors whose full child list came from the service (a detail); the rest may be partial
    public var childrenLoaded: [String: Bool]
    /// Dependents (ticket keys) from the latest detail, by ticket id; live changes are merged in selectors
    public var dependents: [String: [String]]
    /// Newest createdAt the last snapshot saw (null before one): tells new tickets from unloaded old ones
    @Nullable public var ticketsAsOf: Timestamp?

    public init(
        connected: Bool = false, ready: Bool = false, projects: [String: Project] = [:], tickets: [String: Ticket] = [:],
        sessions: [String: Session] = [:], runs: [String: Run] = [:], summaries: [String: [Summary]] = [:],
        transcripts: [String: TranscriptState] = [:], subagents: [String: [Subagent]] = [:],
        deltas: [String: [String: String]] = [:], watchers: [String: Watcher] = [:], settings: PublicSettings? = nil,
        drivers: [DriverInfo] = [], donePaging: [String: DonePaging] = [:], search: SearchState? = nil,
        keyAliases: [String: String] = [:], missingKeys: [String: Bool] = [:], childrenLoaded: [String: Bool] = [:],
        dependents: [String: [String]] = [:], ticketsAsOf: Timestamp? = nil
    ) {
        self.connected = connected
        self.ready = ready
        self.projects = projects
        self.tickets = tickets
        self.sessions = sessions
        self.runs = runs
        self.summaries = summaries
        self.transcripts = transcripts
        self.subagents = subagents
        self.deltas = deltas
        self.watchers = watchers
        self.settings = settings
        self.drivers = drivers
        self.donePaging = donePaging
        self.search = search
        self.keyAliases = keyAliases
        self.missingKeys = missingKeys
        self.childrenLoaded = childrenLoaded
        self.dependents = dependents
        self.ticketsAsOf = ticketsAsOf
    }

    /// `initialState`
    public static let initial = BoardState()
}

/// What a snapshot carries (reducer.ts Snapshot).
public struct BoardSnapshot: Codable, Sendable, Equatable {
    public struct DonePage: Codable, Sendable, Equatable {
        public var scope: String
        public var page: TicketPage
        public init(scope: String, page: TicketPage) {
            self.scope = scope
            self.page = page
        }
    }

    public var projects: [Project]
    public var tickets: [Ticket]
    public var sessions: [Session]
    public var watchers: [Watcher]
    @Nullable public var settings: PublicSettings?
    public var drivers: [DriverInfo]
    /// The first done page for the board's current scope (tickets holds every non-done ticket)
    public var donePage: DonePage?

    public init(
        projects: [Project] = [], tickets: [Ticket] = [], sessions: [Session] = [], watchers: [Watcher] = [],
        settings: PublicSettings? = nil, drivers: [DriverInfo] = [], donePage: DonePage? = nil
    ) {
        self.projects = projects
        self.tickets = tickets
        self.sessions = sessions
        self.watchers = watchers
        self.settings = settings
        self.drivers = drivers
        self.donePage = donePage
    }
}

/// Every action the reducer takes (reducer.ts Action + paging.ts PagingAction). Codable in the
/// TS shape (`{ "type": "donePage.request", "scope": … }`) so fixture sequences decode directly.
public enum BoardAction: Codable, Sendable, Equatable {
    case event(HarnessEvent)
    case snapshot(BoardSnapshot)
    case connected(Bool)
    /// `requestedKey`: the key the detail was fetched by (an old key records an alias)
    case detail(TicketDetail, requestedKey: String? = nil)
    /// Tickets fetched outside a snapshot/page (e.g. one project's full list): merged, newer live versions win
    case tickets([Ticket])
    /// The service has no ticket with these keys (404)
    case missingKeys([String])
    /// A transcript backfill: the session agent's, or with `subagentId` one sub-agent's
    case transcript(sessionId: String, subagentId: String? = nil, entries: [TranscriptEntry])
    case subagents(sessionId: String, subagents: [Subagent])
    case summaries(sessionId: String, summaries: [Summary])
    case drivers([DriverInfo])
    /// A done page request for `scope` went out
    case donePageRequest(scope: String)
    /// `cursor` is the cursor the page was requested with (`.null` for a first page, `.absent` when
    /// unknown). An appended page only applies while it still matches the scope's nextCursor, so a
    /// "Load more" that was in flight when a refresh re-seeded the scope can't splice a stale page
    /// (and cursor) into the new run.
    case donePage(scope: String, page: TicketPage, append: Bool, cursor: Patch<String> = .absent)
    case donePageError(scope: String, error: String)
    /// The board's filter box changed ("" clears the search)
    case searchSet(q: String, scope: String)
    /// A search request went out for the current q/scope (first page or more)
    case searchRequest(q: String, scope: String)
    case searchResults(q: String, scope: String, page: TicketPage, append: Bool)
    case searchError(q: String, scope: String, error: String)

    /// The wire discriminator.
    public var type: String {
        switch self {
        case .event: "event"
        case .snapshot: "snapshot"
        case .connected: "connected"
        case .detail: "detail"
        case .tickets: "tickets"
        case .missingKeys: "missingKeys"
        case .transcript: "transcript"
        case .subagents: "subagents"
        case .summaries: "summaries"
        case .drivers: "drivers"
        case .donePageRequest: "donePage.request"
        case .donePage: "donePage"
        case .donePageError: "donePage.error"
        case .searchSet: "search.set"
        case .searchRequest: "search.request"
        case .searchResults: "search.results"
        case .searchError: "search.error"
        }
    }

    private enum Key: String, CodingKey {
        case type, event, snapshot, connected, detail, requestedKey, tickets, keys, sessionId, subagentId, entries
        case subagents, summaries, drivers, scope, page, append, cursor, error, q
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "event": self = .event(try c.decode(HarnessEvent.self, forKey: .event))
        case "snapshot": self = .snapshot(try c.decode(BoardSnapshot.self, forKey: .snapshot))
        case "connected": self = .connected(try c.decode(Bool.self, forKey: .connected))
        case "detail":
            self = .detail(try c.decode(TicketDetail.self, forKey: .detail), requestedKey: try c.decodeIfPresent(String.self, forKey: .requestedKey))
        case "tickets": self = .tickets(try c.decode([Ticket].self, forKey: .tickets))
        case "missingKeys": self = .missingKeys(try c.decode([String].self, forKey: .keys))
        case "transcript":
            self = .transcript(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                subagentId: try c.decodeIfPresent(String.self, forKey: .subagentId),
                entries: try c.decode([TranscriptEntry].self, forKey: .entries))
        case "subagents":
            self = .subagents(sessionId: try c.decode(String.self, forKey: .sessionId), subagents: try c.decode([Subagent].self, forKey: .subagents))
        case "summaries":
            self = .summaries(sessionId: try c.decode(String.self, forKey: .sessionId), summaries: try c.decode([Summary].self, forKey: .summaries))
        case "drivers": self = .drivers(try c.decode([DriverInfo].self, forKey: .drivers))
        case "donePage.request": self = .donePageRequest(scope: try c.decode(String.self, forKey: .scope))
        case "donePage":
            self = .donePage(
                scope: try c.decode(String.self, forKey: .scope), page: try c.decode(TicketPage.self, forKey: .page),
                append: try c.decode(Bool.self, forKey: .append), cursor: try c.decode(Patch<String>.self, forKey: .cursor))
        case "donePage.error":
            self = .donePageError(scope: try c.decode(String.self, forKey: .scope), error: try c.decode(String.self, forKey: .error))
        case "search.set": self = .searchSet(q: try c.decode(String.self, forKey: .q), scope: try c.decode(String.self, forKey: .scope))
        case "search.request": self = .searchRequest(q: try c.decode(String.self, forKey: .q), scope: try c.decode(String.self, forKey: .scope))
        case "search.results":
            self = .searchResults(
                q: try c.decode(String.self, forKey: .q), scope: try c.decode(String.self, forKey: .scope),
                page: try c.decode(TicketPage.self, forKey: .page), append: try c.decode(Bool.self, forKey: .append))
        case "search.error":
            self = .searchError(q: try c.decode(String.self, forKey: .q), scope: try c.decode(String.self, forKey: .scope), error: try c.decode(String.self, forKey: .error))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown action type \(type)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(type, forKey: .type)
        switch self {
        case let .event(e): try c.encode(e, forKey: .event)
        case let .snapshot(s): try c.encode(s, forKey: .snapshot)
        case let .connected(b): try c.encode(b, forKey: .connected)
        case let .detail(d, requestedKey):
            try c.encode(d, forKey: .detail)
            try c.encodeIfPresent(requestedKey, forKey: .requestedKey)
        case let .tickets(t): try c.encode(t, forKey: .tickets)
        case let .missingKeys(k): try c.encode(k, forKey: .keys)
        case let .transcript(sessionId, subagentId, entries):
            try c.encode(sessionId, forKey: .sessionId)
            try c.encodeIfPresent(subagentId, forKey: .subagentId)
            try c.encode(entries, forKey: .entries)
        case let .subagents(sessionId, subagents):
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(subagents, forKey: .subagents)
        case let .summaries(sessionId, summaries):
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(summaries, forKey: .summaries)
        case let .drivers(d): try c.encode(d, forKey: .drivers)
        case let .donePageRequest(scope): try c.encode(scope, forKey: .scope)
        case let .donePage(scope, page, append, cursor):
            try c.encode(scope, forKey: .scope)
            try c.encode(page, forKey: .page)
            try c.encode(append, forKey: .append)
            try c.encode(cursor, forKey: .cursor)
        case let .donePageError(scope, error):
            try c.encode(scope, forKey: .scope)
            try c.encode(error, forKey: .error)
        case let .searchSet(q, scope), let .searchRequest(q, scope):
            try c.encode(q, forKey: .q)
            try c.encode(scope, forKey: .scope)
        case let .searchResults(q, scope, page, append):
            try c.encode(q, forKey: .q)
            try c.encode(scope, forKey: .scope)
            try c.encode(page, forKey: .page)
            try c.encode(append, forKey: .append)
        case let .searchError(q, scope, error):
            try c.encode(q, forKey: .q)
            try c.encode(scope, forKey: .scope)
            try c.encode(error, forKey: .error)
        }
    }
}

/// The five board columns (TS `Record<TicketStatus, Ticket[]>`). A ticket with a status this build
/// doesn't know has no column and is left out.
public struct Columns: Codable, Sendable, Equatable {
    public var planning: [Ticket] = []
    public var inProgress: [Ticket] = []
    public var blocked: [Ticket] = []
    public var review: [Ticket] = []
    public var done: [Ticket] = []

    public init(planning: [Ticket] = [], inProgress: [Ticket] = [], blocked: [Ticket] = [], review: [Ticket] = [], done: [Ticket] = []) {
        self.planning = planning
        self.inProgress = inProgress
        self.blocked = blocked
        self.review = review
        self.done = done
    }

    enum CodingKeys: String, CodingKey {
        case planning, inProgress = "in_progress", blocked, review, done
    }

    /// The column for a status; empty (and ignoring writes) for an unknown one.
    public subscript(status: TicketStatus) -> [Ticket] {
        get {
            switch status {
            case .planning: planning
            case .inProgress: inProgress
            case .blocked: blocked
            case .review: review
            case .done: done
            case .unknown: []
            }
        }
        set {
            switch status {
            case .planning: planning = newValue
            case .inProgress: inProgress = newValue
            case .blocked: blocked = newValue
            case .review: review = newValue
            case .done: done = newValue
            case .unknown: break
            }
        }
    }

    /// Every ticket, column by column in lifecycle order.
    public var all: [Ticket] { planning + inProgress + blocked + review + done }
}

// JS string semantics the reducer and selectors rely on (UTF-16 code units, as `<` and
// `includes` compare in JavaScript).
enum JSString {
    /// `a < b` on JS strings.
    static func less(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    /// `hay.includes(needle)` on code units ("é" as e + U+0301 includes "e").
    static func includes(_ hay: String, _ needle: String) -> Bool {
        let h = Array(hay.utf16), n = Array(needle.utf16)
        if n.isEmpty { return true }
        if n.count > h.count { return false }
        for i in 0...(h.count - n.count) where h[i] == n[0] {
            if Array(h[i..<(i + n.count)]) == n { return true }
        }
        return false
    }

    /// `s.toUpperCase()` / `s.toLowerCase()`: full Unicode case mapping, locale-independent, as in JS.
    static func upper(_ s: String) -> String { s.uppercased() }
    static func lower(_ s: String) -> String { s.lowercased() }
}
