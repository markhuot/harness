import Foundation
import Testing
@testable import HarnessKit

@Suite("Widgets: what the app writes for them, and when it reloads them")
struct WidgetSyncTests {
    static let server = ActiveServer(server: SavedServer(id: "s1", name: "Mac", baseUrl: "http://mac:7717", addedAt: 1), token: "tok")

    static func board(ready: Bool, _ tickets: [Ticket]) -> BoardState {
        BoardState(ready: ready, tickets: Dictionary(uniqueKeysWithValues: tickets.map { ($0.id, $0) }))
    }

    static func state(_ tickets: [Ticket], token: String = "tok", now: Double = 1) -> WidgetSyncState {
        let server = ActiveServer(server: Self.server.server, token: token)
        return WidgetSyncState.current(active: server, prefs: .defaults, board: board(ready: true, tickets), now: now)
    }

    @Test func noServerMeansNoHostAndNoSnapshot() {
        let s = WidgetSyncState.current(active: nil, prefs: .defaults, board: Self.board(ready: true, [WidgetFeedTests.ticket(1, .inProgress)]), now: 1)
        #expect(s == WidgetSyncState())
    }

    @Test func theHostCarriesTheServerAndThemes() {
        var prefs = Prefs.defaults
        prefs.darkTheme = "catppuccin-mocha"
        let s = WidgetSyncState.current(active: Self.server, prefs: prefs, board: nil, now: 1)
        #expect(s.host == WidgetHost(baseUrl: "http://mac:7717", token: "tok", name: "Mac", lightTheme: prefs.lightTheme, darkTheme: "catppuccin-mocha"))
    }

    @Test func aBoardThatHasntLoadedLeavesTheSavedSnapshot() {
        let s = WidgetSyncState.current(active: Self.server, prefs: .defaults, board: Self.board(ready: false, []), now: 1)
        #expect(s.host != nil)
        #expect(s.snapshot == nil)
        let previous = Self.state([WidgetFeedTests.ticket(1, .inProgress)])
        let plan = s.plan(from: previous)
        #expect(plan.snapshot == .none)
        #expect(!plan.reload)
        #expect(s.written(after: previous).snapshot == previous.snapshot)
    }

    @Test func theFirstSyncWritesEverythingAndReloads() {
        let s = Self.state([WidgetFeedTests.ticket(1, .inProgress)])
        let plan = s.plan(from: nil)
        #expect(plan.host == .some(s.host))
        #expect(plan.snapshot == .some(s.snapshot))
        #expect(plan.reload)
    }

    @Test func onlyAChangeTheWidgetsShowReloadsThem() {
        let before = Self.state([WidgetFeedTests.ticket(1, .inProgress), WidgetFeedTests.ticket(2, .done)], now: 1)
        // A later snapshot of the same tickets, and a done ticket changing: nothing to do.
        var done = WidgetFeedTests.ticket(2, .done)
        done.title = "Renamed"
        let same = Self.state([WidgetFeedTests.ticket(1, .inProgress), done], now: 50)
        #expect(same.plan(from: before) == .nothing)
        // The active ticket moving to review: write and reload.
        let moved = Self.state([WidgetFeedTests.ticket(1, .review)], now: 60)
        let plan = moved.plan(from: before)
        #expect(plan.host == .none)
        #expect(plan.snapshot == .some(moved.snapshot))
        #expect(plan.reload)
    }

    @Test func aRotatedTokenRewritesTheHost() {
        let before = Self.state([WidgetFeedTests.ticket(1, .inProgress)])
        let after = Self.state([WidgetFeedTests.ticket(1, .inProgress)], token: "new")
        let plan = after.plan(from: before)
        #expect(plan.host == .some(after.host))
        #expect(plan.snapshot == .none)
        #expect(plan.reload)
    }

    @Test func forgettingTheServerClearsBothOnce() {
        let before = Self.state([WidgetFeedTests.ticket(1, .inProgress)])
        let gone = WidgetSyncState()
        let plan = gone.plan(from: before)
        #expect(plan.host == .some(nil))
        #expect(plan.snapshot == .some(nil))
        #expect(plan.reload)
        #expect(gone.plan(from: gone.written(after: before)) == .nothing)
    }
}
