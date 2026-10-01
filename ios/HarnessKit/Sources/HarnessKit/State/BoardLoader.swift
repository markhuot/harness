import Foundation

// Port of mobile/src/lib/boardLoader.ts: the iPhone board's I/O for paged Done columns and
// server-side search. The state and selectors are shared (Paging.swift); this decides WHEN to ask
// the service for what, and drops answers that arrive too late. Client, dispatch, state getter and
// timers are injected so tests drive it without a service or real waiting.
//
// Two phone-specific problems it exists for:
// - A list's "near the end" callback fires repeatedly (every scroll event near the end, again after
//   the data changes, and before the view has re-rendered the "loading" state), so the gate
//   remembers which page it already asked for instead of trusting the state it was handed.
// - Every refetch (pull to refresh, reconnect, back from the background) starts paging over. A
//   page or search result requested before it must not be merged after it: it would carry the
//   old cursor into the new paging run, or older data over newer. A generation counter per
//   snapshot and per query rules those out.
//
// Request-starting methods do their bookkeeping (gates, the "request" dispatch) synchronously,
// as the TS does before its first await, and return the Task that finishes the request.

@MainActor
public final class BoardLoader {
    /// Below this many visible Done cards (child tickets hidden) the column loads another page itself.
    public static let autofillMin = 12

    /// Hidden child tickets can leave a loaded Done page nearly empty, and a list only reports
    /// "near the end" once there's something to scroll, so a short column asks for the next page itself.
    public static func shouldAutoFill(visibleCount: Int, canLoad: Bool, min: Int = autofillMin) -> Bool {
        canLoad && visibleCount < min
    }

    private let client: any LoaderClient
    private let dispatch: @MainActor (BoardAction) -> Void
    /// The latest state the app has (may lag the dispatches just made)
    private let getState: @MainActor () -> BoardState
    private let describe: @MainActor (any Error) -> String
    private let timers: any Timers
    private let debounceMs: Double

    private var gen = 0
    /// "\(gen)|\(scope)|\(cursor)" of pages asked for in this generation (failed ones are removed)
    private var asked: Set<String> = []
    private var searchGen = 0
    private var searchAsked: Set<String> = []
    private var timer: TimerHandle?
    private var query = (q: "", scope: "")
    /// The service predates paging (GET /tickets/page 404s): the snapshot carried every done ticket
    public var legacy = false

    public init(
        client: any LoaderClient,
        dispatch: @escaping @MainActor (BoardAction) -> Void,
        getState: @escaping @MainActor () -> BoardState,
        describe: (@MainActor (any Error) -> String)? = nil,
        timers: any Timers = TaskTimers(),
        debounceMs: Double = Paging.searchDebounceMs
    ) {
        self.client = client
        self.dispatch = dispatch
        self.getState = getState
        self.describe = describe ?? { errorMessage($0) }
        self.timers = timers
        self.debounceMs = debounceMs
    }

    /// A snapshot was just dispatched: everything in flight belongs to the old paging run.
    public func snapshotApplied() {
        gen += 1
        asked.removeAll()
        searchGen += 1
        searchAsked.removeAll()
        if !query.q.isEmpty { runSearch(searchGen, cursor: nil) }
    }

    /// The board shows `projectId`: fetch its first Done page unless it has one.
    @discardableResult
    public func ensureFirstPage(_ projectId: String?) -> Task<Void, Never>? {
        if legacy || !Paging.needsFirstDonePage(getState(), projectId) { return nil }
        return fetchDone(projectId, cursor: nil)
    }

    /// Is there a next Done page this gate would ask for right now? (drives the footer spinner / autofill)
    public func canLoadMoreDone(_ projectId: String?) -> Bool {
        let state = getState()
        guard !legacy, let p = state.donePaging[Paging.scopeOf(projectId)] else { return false }
        // After a failure the column waits for Retry: a failing service would otherwise be hit by every scroll event.
        return p.error == nil && Paging.canLoadMoreDone(state, projectId) && !asked.contains(key(projectId, p.nextCursor))
    }

    /// The Done list scrolled near its end (or is too short to scroll).
    @discardableResult
    public func loadMoreDone(_ projectId: String?) -> Task<Void, Never>? {
        guard canLoadMoreDone(projectId) else { return nil }
        return fetchDone(projectId, cursor: getState().donePaging[Paging.scopeOf(projectId)]?.nextCursor)
    }

    /// Footer "Retry" after a failed page.
    @discardableResult
    public func retryDone(_ projectId: String?) -> Task<Void, Never>? {
        guard let p = getState().donePaging[Paging.scopeOf(projectId)], p.error != nil, !legacy else { return nil }
        return fetchDone(projectId, cursor: p.nextCursor)
    }

    private func key(_ projectId: String?, _ cursor: String?) -> String {
        "\(gen)|\(Paging.scopeOf(projectId))|\(cursor ?? "")"
    }

    private func fetchDone(_ projectId: String?, cursor: String?) -> Task<Void, Never>? {
        let key = key(projectId, cursor)
        if asked.contains(key) { return nil }
        asked.insert(key)
        let gen = gen
        let scope = Paging.scopeOf(projectId)
        dispatch(.donePageRequest(scope: scope))
        let client = client
        return Task { @MainActor in
            do {
                let page = try await client.ticketPage(status: .done, projectId: Paging.scopeProject(scope), q: nil, limit: Paging.donePageSize, cursor: cursor)
                guard gen == self.gen else { return }
                self.dispatch(.donePage(scope: scope, page: page, append: cursor != nil, cursor: Patch(cursor)))
            } catch {
                guard gen == self.gen else { return }
                self.asked.remove(key)
                self.dispatch(.donePageError(scope: scope, error: self.describe(error)))
            }
        }
    }

    // MARK: Search

    /// Every keystroke in the search bar (and project switches while searching). The reducer shows
    /// local matches at once; the server is asked after a pause, and only the newest ask may land.
    public func setQuery(_ raw: String, projectId: String?) {
        let q = JSCompat.trim(raw)
        let scope = Paging.scopeOf(projectId)
        if q == query.q && scope == query.scope { return }
        query = (q, scope)
        searchGen += 1
        searchAsked.removeAll()
        if let timer { timers.clear(timer) }
        timer = nil
        dispatch(.searchSet(q: q, scope: scope))
        if q.isEmpty { return }
        let gen = searchGen
        timer = timers.set(debounceMs) { [weak self] in
            guard let self else { return }
            self.timer = nil
            self.runSearch(gen, cursor: nil)
        }
    }

    public func canLoadMoreSearch() -> Bool {
        guard let s = getState().search else { return false }
        return s.error == nil && Paging.canLoadMoreSearch(s) && s.q == query.q && !searchAsked.contains(s.nextCursor ?? "")
    }

    /// Any column of the search results scrolled near its end: the next page of matches.
    @discardableResult
    public func loadMoreSearch() -> Task<Void, Never>? {
        guard canLoadMoreSearch() else { return nil }
        return runSearch(searchGen, cursor: getState().search?.nextCursor)
    }

    /// Footer "Retry" after a failed search request.
    @discardableResult
    public func retrySearch() -> Task<Void, Never>? {
        guard let s = getState().search, s.error != nil, s.q == query.q else { return nil }
        return runSearch(searchGen, cursor: s.ids == nil ? nil : s.nextCursor)
    }

    @discardableResult
    private func runSearch(_ gen: Int, cursor: String?) -> Task<Void, Never>? {
        guard gen == searchGen else { return nil }
        let (q, scope) = query
        if q.isEmpty { return nil }
        let askedKey = cursor ?? ""
        if cursor != nil && searchAsked.contains(askedKey) { return nil }
        searchAsked.insert(askedKey)
        dispatch(.searchRequest(q: q, scope: scope))
        let client = client
        return Task { @MainActor in
            do {
                let page = try await client.searchTickets(q: q, projectId: Paging.scopeProject(scope), limit: Paging.searchPageSize, cursor: cursor)
                guard gen == self.searchGen else { return }
                self.dispatch(.searchResults(q: q, scope: scope, page: page, append: cursor != nil))
            } catch {
                guard gen == self.searchGen else { return }
                self.searchAsked.remove(askedKey)
                self.dispatch(.searchError(q: q, scope: scope, error: self.describe(error)))
            }
        }
    }

    /// The store is going away: nothing in flight may land.
    public func dispose() {
        gen += 1
        searchGen += 1
        if let timer { timers.clear(timer) }
        timer = nil
    }
}
