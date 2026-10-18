import Foundation
import Testing
import HarnessKit

private final class FakeDefaults: ChangesDefaults, @unchecked Sendable {
    var values: [String: String] = [:]
    func string(forKey key: String) -> String? { values[key] }
    func setString(_ value: String, forKey key: String) { values[key] = value }
}

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private let hour: TimeInterval = 3600

@MainActor
private func router(open keys: [String] = [], dock: Bool = false) -> Router {
    let r = Router()
    for key in keys { r.openTicket(key: key, tab: nil) }
    if dock { r.dockSheet() }
    return r
}

@MainActor @Suite struct RouterRestoreTests {
    // MARK: Sheets across launches

    @Test func anOpenAndADockedStackRoundTripsWithOrderAndTheDockFlag() throws {
        let saved = router(open: ["A-1", "A-2", "A-3"])
        saved.setTicketSheetPath([.ticket(key: "A-9", tab: .spec)])
        let presented = saved.persistedState(now: t0)

        let fresh = Router()
        #expect(fresh.restorePersistedState(presented, now: t0 + hour))
        #expect(fresh.dockedSheets.map(\.rootKey) == ["A-3", "A-2", "A-1"])
        #expect(fresh.dockedSheets.first?.path == [.ticket(key: "A-9", tab: .spec)])
        #expect(fresh.ticketSheetState == .presented)

        saved.dockSheet()
        let docked = Router()
        docked.restorePersistedState(saved.persistedState(now: t0), now: t0)
        #expect(docked.ticketSheetState == .docked)
    }

    @Test func aTabPickedOnATicketComesBackWithTheSheet() {
        let saved = router(open: ["A-1"])
        saved.setTicketTab(.spec, key: "A-1")
        let fresh = Router()
        fresh.restorePersistedState(saved.persistedState(now: t0), now: t0)
        #expect(fresh.ticketTab(key: "A-1") == .spec)
        #expect(fresh.ticketTab(key: "A-2") == nil)
    }

    @Test func stateOlderThanADayIsDiscardedAndOneInsideItIsKept() {
        let json = router(open: ["A-1"]).persistedState(now: t0)
        let stale = Router()
        #expect(!stale.restorePersistedState(json, now: t0 + Router.persistedStateMaxAge + 1))
        #expect(stale.ticketSheetState == .gone)
        let fresh = Router()
        #expect(fresh.restorePersistedState(json, now: t0 + Router.persistedStateMaxAge - 1))
        #expect(fresh.ticketSheetState == .presented)
    }

    @Test func garbageAndUnknownRootsDropWhileTheRestRestore() {
        let r = Router()
        #expect(!r.restorePersistedState("not json", now: t0))
        #expect(r.ticketSheetState == .gone)

        let json = """
        {"version":1,"savedAt":1800000000,"docked":true,"sheets":[
          {"root":{"mystery":{}},"path":[]},
          {"root":{"ticket":{"key":"A-1"}},"path":[{"nope":{}}]}]}
        """
        #expect(r.restorePersistedState(json, now: t0))
        #expect(r.dockedSheets.map(\.rootKey) == ["A-1"])
        #expect(r.dockedSheets.first?.path == [])
    }

    @Test func theOlderDockedOnlyPayloadStillRestoresDockedAndIsEmptiedOnce() {
        let defaults = FakeDefaults()
        defaults.values[Router.persistedDockKey] = #"[{"root":{"ticket":{"key":"A-1"}},"path":[]}]"#
        let r = Router()
        r.restorePersisted(from: defaults, server: "s1", now: t0)
        #expect(r.ticketSheetState == .docked)
        #expect(r.dockedSheets.map(\.rootKey) == ["A-1"])
        #expect(defaults.values[Router.persistedDockKey] == "")
    }

    @Test func eachServerKeepsItsOwnState() {
        let defaults = FakeDefaults()
        router(open: ["A-1"]).savePersisted(to: defaults, server: "s1", now: t0)
        let other = Router()
        other.restorePersisted(from: defaults, server: "s2", now: t0)
        #expect(other.ticketSheetState == .gone)
        let same = Router()
        same.restorePersisted(from: defaults, server: "s1", now: t0)
        #expect(same.dockedSheets.map(\.rootKey) == ["A-1"])
    }

    @Test func aLinkOpenedAtLaunchStaysOnTopAndTheSavedSheetsJoinTheDockBehindIt() {
        let json = router(open: ["A-1", "A-2"]).persistedState(now: t0)
        let launched = Router()
        launched.openTicket(key: "A-7", tab: nil)
        launched.restorePersistedState(json, now: t0)
        #expect(launched.ticketSheetState == .presented)
        #expect(launched.dockedSheets.map(\.rootKey) == ["A-7", "A-2", "A-1"])
        // The same ticket opened by the link isn't doubled by the restore.
        let again = Router()
        again.openTicket(key: "A-2", tab: nil)
        again.restorePersistedState(json, now: t0)
        #expect(again.dockedSheets.map(\.rootKey) == ["A-2", "A-1"])
    }

    // MARK: Board column

    @Test func theBoardColumnRoundTripsWithoutAnySheet() {
        let saved = Router()
        saved.boardColumn = .review
        let fresh = Router()
        fresh.restorePersistedState(saved.persistedState(now: t0), now: t0)
        #expect(fresh.boardColumn == .review)
    }

    @Test func aColumnShownBeforeTheRestoreIsNotReplaced() {
        let saved = Router()
        saved.boardColumn = .review
        let fresh = Router()
        fresh.boardColumn = .done
        fresh.restorePersistedState(saved.persistedState(now: t0), now: t0)
        #expect(fresh.boardColumn == .done)
    }

    @Test func nothingToKeepSavesNothing() {
        #expect(Router().persistedState(now: t0) == nil)
    }

    // MARK: Layout flips

    @Test func aDismissalReportedByTheLayoutFlipDoesNotCloseTheTicket() {
        let r = router(open: ["A-1"])
        r.setTicketTab(.spec, key: "A-1")
        r.sheetIsBesideBoard = true
        // The system sheet is withdrawn for the panel; SwiftUI writes nil back.
        r.sheetDismissedBySystem(dock: false, now: Date())
        #expect(r.ticketSheetState == .presented)
        // Back to the compact layout: the same flip, the other way.
        r.sheetIsBesideBoard = false
        r.sheetDismissedBySystem(dock: false, now: Date())
        #expect(r.ticketSheetState == .presented)
        #expect(r.ticketTab(key: "A-1") == .spec)
    }

    @Test func aSwipeAwayLongAfterTheFlipStillClosesTheTicket() {
        let r = router(open: ["A-1"])
        r.sheetIsBesideBoard = true
        r.sheetIsBesideBoard = false
        r.sheetDismissedBySystem(dock: false, now: Date().addingTimeInterval(Router.layoutFlipGrace + 1))
        #expect(r.ticketSheetState == .gone)
    }

    @Test func aSwipeAwayWithNoFlipClosesAndAnArmedReleaseDocks() {
        let closing = router(open: ["A-1"])
        closing.sheetDismissedBySystem(dock: false)
        #expect(closing.ticketSheetState == .gone)
        let docking = router(open: ["A-1"])
        docking.sheetDismissedBySystem(dock: true)
        #expect(docking.ticketSheetState == .docked)
    }

    @Test func flippingTheLayoutKeepsSheetsPathsTabsAndTheDock() {
        let r = router(open: ["A-1", "A-2"])
        r.setTicketSheetPath([.ticket(key: "A-3", tab: nil)])
        r.setTicketTab(.spec, key: "A-3")
        r.dockSheet()
        let before = r.dockedSheets
        r.sheetIsBesideBoard = true
        r.sheetIsBesideBoard = false
        #expect(r.dockedSheets == before)
        #expect(r.ticketSheetState == .docked)
    }
}

private func ticket(_ key: String, status: TicketStatus) -> Ticket {
    Ticket(id: "t-\(key)", key: key, projectId: "p", title: key, spec: "", status: status, sessionId: "s-\(key)", driver: "d", workdir: nil, draft: nil, createdAt: 0, updatedAt: 0)
}

@Suite struct BoardOpeningColumnTests {
    private let shown = Columns(blocked: [ticket("A-1", status: .blocked)])

    @Test func aRememberedColumnBeatsTheLandingColumn() {
        #expect(BoardScreenRules.openingColumn(remembered: .done, shown: shown) == .done)
    }

    @Test func noRememberedOrAnUnknownOneFallsBackToLanding() {
        #expect(BoardScreenRules.openingColumn(remembered: nil, shown: shown) == .blocked)
        #expect(BoardScreenRules.openingColumn(remembered: .unknown("archived"), shown: shown) == .blocked)
    }
}
