import Foundation
import Testing
@testable import HarnessKit

/// BoardLoader: paging the board (auto-fill, load more, retry after a failure, refetch races) and
/// debounced search, checking which requests go out and that stale answers are dropped.
@MainActor
@Suite("BoardLoader")
struct BoardLoaderTests {
    struct PageCall: Sendable {
        let cursor: String?
        let projectId: String?
        let limit: Int?
        let d = Deferred<TicketPage>()
    }

    struct SearchCall: Sendable {
        let q: String
        let cursor: String?
        let projectId: String?
        let d = Deferred<TicketPage>()
    }

    final class FakeClient: LoaderClient {
        let pages = CallLog<PageCall>()
        let searches = CallLog<SearchCall>()

        func ticketPage(status: TicketStatus, projectId: String?, q: String?, limit: Int?, cursor: String?) async throws -> TicketPage {
            let call = PageCall(cursor: cursor, projectId: projectId, limit: limit)
            pages.append(call)
            return try await call.d.value()
        }

        func searchTickets(q: String, projectId: String?, limit: Int?, cursor: String?) async throws -> TicketPage {
            let call = SearchCall(q: q, cursor: cursor, projectId: projectId)
            searches.append(call)
            return try await call.d.value()
        }
    }

    nonisolated(unsafe) static var seq = 0
    static func tk(_ id: String, status: TicketStatus = .done, projectId: String = "p1", title: String? = nil, completedAt: Patch<Timestamp>? = nil) -> Ticket {
        seq += 1
        return Ticket(id: id, key: "T-\(id)", projectId: projectId, title: title ?? id, spec: "", status: status, sessionId: "s-\(id)", driver: "dummy",
                      completedAt: completedAt ?? .value(Double(1000 - seq)), createdAt: Double(seq), updatedAt: Double(seq))
    }

    static func page(_ tickets: [Ticket], _ next: String?, _ total: Int) -> TicketPage {
        TicketPage(tickets: tickets, nextCursor: next, total: total)
    }

    /// A real reducer behind the loader. `lag` makes getState return what the app last rendered
    /// rather than the latest dispatch.
    @MainActor
    final class Harness {
        var state = BoardState.initial
        var rendered = BoardState.initial
        let client = FakeClient()
        let clock = ManualTimers()
        let lag: Bool
        var loader: BoardLoader!

        init(lag: Bool = false) {
            self.lag = lag
            loader = BoardLoader(
                client: client,
                dispatch: { [unowned self] in self.dispatch($0) },
                getState: { [unowned self] in self.rendered },
                timers: clock,
                debounceMs: 200)
        }

        func dispatch(_ a: BoardAction) {
            state.reduce(a)
            if !lag { rendered = state }
        }

        func snapshot(_ open: [Ticket], _ donePage: TicketPage?, scope: String = Paging.allScope) {
            dispatch(.snapshot(BoardSnapshot(tickets: open, donePage: donePage.map { .init(scope: scope, page: $0) })))
            loader.snapshotApplied()
        }

        func render() { rendered = state }
    }

    @Test func shouldAutoFill() {
        #expect(BoardLoader.shouldAutoFill(visibleCount: 0, canLoad: true, min: 12))
        #expect(BoardLoader.shouldAutoFill(visibleCount: 11, canLoad: true, min: 12))
        #expect(!BoardLoader.shouldAutoFill(visibleCount: 12, canLoad: true, min: 12))
        #expect(!BoardLoader.shouldAutoFill(visibleCount: 0, canLoad: false, min: 12))
        #expect(BoardLoader.autofillMin == 12)
    }

    @Test func endReachedTwiceBeforeARenderAsksOnce() async {
        let h = Harness(lag: true)
        h.snapshot([], Self.page([Self.tk("a")], "c1", 3))
        h.render()
        h.loader.loadMoreDone(nil)
        h.loader.loadMoreDone(nil) // stale state still says "not loading"
        await eventually { h.client.pages.count == 1 }
        await settle()
        #expect(h.client.pages.count == 1)
        h.client.pages[0].d.resolve(Self.page([Self.tk("b")], "c2", 3))
        await eventually { h.state.donePaging[Paging.allScope]?.nextCursor == "c2" }
        // The page landed but the app hasn't rendered it: the old cursor must not be asked for again.
        #expect(h.loader.loadMoreDone(nil) == nil)
        h.render()
        h.loader.loadMoreDone(nil)
        await eventually { h.client.pages.count == 2 }
        #expect(h.client.pages.all.map(\.cursor) == ["c1", "c2"])
        #expect(h.client.pages[0].limit == Paging.donePageSize)
    }

    @Test func noRequestWithoutACursorAndNoneAfterAFailureUntilRetry() async {
        let h = Harness()
        h.snapshot([], Self.page([Self.tk("a")], "c1", 5))
        let first = h.loader.loadMoreDone(nil)
        await eventually { h.client.pages.count == 1 }
        h.client.pages[0].d.reject(TestError("offline"))
        await first?.value
        #expect(h.state.donePaging[Paging.allScope]?.error == "offline")
        #expect(!h.loader.canLoadMoreDone(nil))
        #expect(h.loader.loadMoreDone(nil) == nil)
        let retry = h.loader.retryDone(nil)
        await eventually { h.client.pages.count == 2 }
        #expect(h.client.pages[1].cursor == "c1")
        h.client.pages[1].d.resolve(Self.page([Self.tk("b")], nil, 5))
        await retry?.value
        #expect(!h.loader.canLoadMoreDone(nil)) // last page
        #expect(h.loader.loadMoreDone(nil) == nil)
        #expect(h.loader.retryDone(nil) == nil) // nothing failed
        #expect(h.state.boardColumns(nil).done.map(\.id) == ["a", "b"])
    }

    @Test func aLoadMorePageThatLandsAfterARefetchIsDropped() async {
        let h = Harness()
        h.snapshot([], Self.page([Self.tk("a")], "old-cursor", 9))
        let more = h.loader.loadMoreDone(nil)
        await eventually { h.client.pages.count == 1 }
        h.snapshot([], Self.page([Self.tk("fresh")], "new-cursor", 9)) // back from the background
        h.client.pages[0].d.resolve(Self.page([Self.tk("stale")], "older-cursor", 9))
        await more?.value
        #expect(h.state.tickets["stale"] == nil)
        #expect(h.state.donePaging[Paging.allScope]?.nextCursor == "new-cursor")
        h.loader.loadMoreDone(nil)
        await eventually { h.client.pages.count == 2 }
        #expect(h.client.pages.last?.cursor == "new-cursor")
    }

    @Test func aFailureAfterARefetchIsDroppedToo() async {
        let h = Harness()
        h.snapshot([], Self.page([Self.tk("a")], "c1", 9))
        let more = h.loader.loadMoreDone(nil)
        await eventually { h.client.pages.count == 1 }
        h.snapshot([], Self.page([Self.tk("fresh")], "c2", 9))
        h.client.pages[0].d.reject(TestError("offline"))
        await more?.value
        #expect(h.state.donePaging[Paging.allScope]?.error == nil)
        #expect(h.loader.canLoadMoreDone(nil))
    }

    @Test func ensureFirstPageFetchesOnceAndTheLegacyServiceIsNeverPaged() async {
        let h = Harness()
        h.snapshot([], Self.page([], nil, 0))
        let p = h.loader.ensureFirstPage("p2")
        #expect(h.loader.ensureFirstPage("p2") == nil)
        await eventually { h.client.pages.count == 1 }
        #expect(h.client.pages.all.map { [$0.projectId, $0.cursor] } == [["p2", nil]])
        h.client.pages[0].d.resolve(Self.page([Self.tk("x", projectId: "p2")], nil, 1))
        await p?.value
        #expect(h.loader.ensureFirstPage("p2") == nil)
        await settle()
        #expect(h.client.pages.count == 1)

        let old = Harness()
        old.loader.legacy = true
        old.snapshot([Self.tk("d1")], nil)
        #expect(old.loader.ensureFirstPage(nil) == nil)
        #expect(old.loader.loadMoreDone(nil) == nil)
        #expect(!old.loader.canLoadMoreDone(nil))
        await settle()
        #expect(old.client.pages.count == 0)
    }

    @Test func searchIsDebouncedToOneRequestForTheLastTextOfABurst() async {
        let h = Harness()
        h.snapshot([], Self.page([], nil, 0))
        h.loader.setQuery("g", projectId: nil)
        h.loader.setQuery("gr", projectId: nil)
        h.loader.setQuery("gre ", projectId: nil)
        #expect(h.clock.count == 1)
        #expect(h.clock.delays == [200])
        await settle()
        #expect(h.client.searches.count == 0)
        #expect(h.state.search?.q == "gre")
        #expect(h.state.search?.ids == nil)
        h.clock.advance(by: 199)
        await settle()
        #expect(h.client.searches.count == 0)
        h.clock.advance(by: 1)
        await eventually { h.client.searches.count == 1 }
        #expect(h.client.searches.all.map(\.q) == ["gre"])
        h.loader.setQuery("gre", projectId: nil) // trailing space trimmed away: same query, no new request
        h.clock.fireAll()
        await settle()
        #expect(h.client.searches.count == 1)
    }

    @Test func aSlowResponseForAnEarlierQueryNeverOverwritesANewerOne() async {
        let h = Harness()
        h.snapshot([], Self.page([], nil, 0))
        h.loader.setQuery("ab", projectId: nil)
        h.clock.fireAll()
        await eventually { h.client.searches.count == 1 }
        h.loader.setQuery("abc", projectId: nil)
        h.clock.fireAll()
        await eventually { h.client.searches.count == 2 }
        h.loader.setQuery("ab", projectId: nil) // backspace: same text as the first, slow request
        h.clock.fireAll()
        await eventually { h.client.searches.count == 3 }
        #expect(h.client.searches.all.map(\.q) == ["ab", "abc", "ab"])
        h.client.searches[2].d.resolve(Self.page([Self.tk("new", title: "ab renamed")], nil, 1))
        await eventually { h.state.search?.ids == ["new"] }
        h.client.searches[0].d.resolve(Self.page([Self.tk("ancient")], nil, 1))
        h.client.searches[1].d.resolve(Self.page([Self.tk("abc-hit")], nil, 1))
        await settle()
        #expect(h.state.search?.ids == ["new"])
        #expect(h.state.tickets["ancient"] == nil)
    }

    @Test func clearingTheSearchCancelsThePendingDebounceAndDropsTheResponseInFlight() async {
        let h = Harness()
        h.snapshot([], Self.page([], nil, 0))
        h.loader.setQuery("first", projectId: nil)
        h.clock.fireAll()
        await eventually { h.client.searches.count == 1 }
        h.loader.setQuery("second", projectId: nil)
        h.loader.setQuery("", projectId: nil)
        #expect(h.state.search == nil)
        #expect(h.clock.count == 0)
        h.clock.fireAll()
        await settle()
        #expect(h.client.searches.all.map(\.q) == ["first"])
        h.client.searches[0].d.resolve(Self.page([Self.tk("late")], nil, 1))
        await settle()
        #expect(h.state.search == nil)
        #expect(h.state.tickets["late"] == nil)
    }

    @Test func searchLoadMorePagesWithTheCursorOnce() async {
        let h = Harness()
        h.snapshot([], Self.page([], nil, 0))
        h.loader.setQuery("x", projectId: "p1")
        h.clock.fireAll()
        await eventually { h.client.searches.count == 1 }
        #expect(h.client.searches[0].projectId == "p1")
        h.client.searches[0].d.resolve(Self.page([Self.tk("d1"), Self.tk("r1", status: .review, completedAt: .null)], "s1", 3))
        await eventually { h.state.search?.ids != nil }
        h.loader.loadMoreSearch()
        #expect(h.loader.loadMoreSearch() == nil)
        await eventually { h.client.searches.count == 2 }
        await settle()
        #expect(h.client.searches.all.filter { $0.cursor == "s1" }.count == 1)
        h.client.searches[1].d.resolve(Self.page([Self.tk("d2")], nil, 3))
        await eventually { h.state.search?.ids?.count == 3 }
        let r = Paging.searchColumns(h.state, "p1")
        #expect(!r.pending)
        #expect(r.columns.done.map(\.id) == ["d1", "d2"])
        #expect(r.columns.review.map(\.id) == ["r1"])
        #expect(!h.loader.canLoadMoreSearch())
    }

    @Test func aFailedSearchWaitsForRetryWhichReRunsTheFirstPage() async {
        let h = Harness()
        h.snapshot([], Self.page([], nil, 0))
        h.loader.setQuery("x", projectId: nil)
        h.clock.fireAll()
        await eventually { h.client.searches.count == 1 }
        h.client.searches[0].d.reject(TestError("offline"))
        await eventually { h.state.search?.error == "offline" }
        #expect(!h.loader.canLoadMoreSearch())
        let retry = h.loader.retrySearch()
        await eventually { h.client.searches.count == 2 }
        #expect(h.client.searches[1].cursor == nil)
        h.client.searches[1].d.resolve(Self.page([Self.tk("a")], nil, 1))
        await retry?.value
        #expect(h.state.search?.ids == ["a"])
        #expect(h.loader.retrySearch() == nil)
    }

    @Test func aRefetchReRunsTheActiveSearchAndIgnoresTheAnswerBeforeIt() async {
        let h = Harness()
        h.snapshot([], Self.page([], nil, 0))
        h.loader.setQuery("zap", projectId: nil)
        h.clock.fireAll()
        await eventually { h.client.searches.count == 1 }
        h.snapshot([], Self.page([], nil, 0))
        await eventually { h.client.searches.count == 2 }
        #expect(h.client.searches.all.map(\.q) == ["zap", "zap"])
        h.client.searches[1].d.resolve(Self.page([Self.tk("fresh")], nil, 1))
        await eventually { h.state.search?.ids == ["fresh"] }
        h.client.searches[0].d.resolve(Self.page([Self.tk("stale")], nil, 1))
        await settle()
        #expect(h.state.search?.ids == ["fresh"])
    }

    @Test func disposeDropsEverythingInFlight() async {
        let h = Harness()
        h.snapshot([], Self.page([Self.tk("a")], "c1", 3))
        let more = h.loader.loadMoreDone(nil)
        h.loader.setQuery("q", projectId: nil)
        h.loader.dispose()
        #expect(h.clock.count == 0)
        await eventually { h.client.pages.count == 1 }
        h.client.pages[0].d.resolve(Self.page([Self.tk("late")], nil, 3))
        await more?.value
        #expect(h.state.tickets["late"] == nil)
    }
}
