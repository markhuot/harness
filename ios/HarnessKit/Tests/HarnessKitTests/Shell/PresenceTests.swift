import Foundation
import Synchronization
import Testing
@testable import HarnessKit

/// What this device reports as on screen (DESIGN.md "Notifications"), so the service holds back
/// notifications for tickets the person is already looking at.
@MainActor
@Suite("Presence")
struct PresenceTests {
    private let board = ["B-1", "B-2"]
    private func t(_ key: String) -> Route { .ticket(key: key, tab: nil) }
    private func shown(_ r: Router) -> [String] { PresenceRules.tickets(r) { board } }

    // MARK: A main window

    @Test func theBoardAtItsRootShowsItsCards() {
        let r = Router()
        #expect(shown(r) == board)
    }

    @Test func otherSectionsShowNoTicketsAndNeverAskForTheBoard() {
        let r = Router()
        r.open(.tab(.settings))
        var asked = false
        #expect(PresenceRules.tickets(r) { asked = true; return board }.isEmpty)
        #expect(!asked)
        r.push(.prompts)
        #expect(shown(r).isEmpty)
    }

    @Test func aTicketOnTheStackReplacesTheBoard() {
        let r = Router()
        r.setPath(.board, [t("A-1")])
        #expect(shown(r) == ["A-1"])
        // A file pushed from the ticket: still that ticket's.
        r.setPath(.board, [t("A-1"), .file(FileRouteParams(path: "a.ts", ticket: "A-1"))])
        #expect(shown(r) == ["A-1"])
        r.popToRoot()
        #expect(shown(r) == board)
    }

    @Test func aPresentedSheetCountsAsJustItsTopTicket() {
        let r = Router()
        r.push(t("A-1"))
        #expect(shown(r) == ["A-1"])
        r.push(.file(FileRouteParams(path: "a.ts", ticket: "A-1")))
        #expect(shown(r) == ["A-1"])
        r.push(t("A-2"))
        #expect(shown(r) == ["A-2"])
        r.dismissSheet()
        #expect(shown(r) == board)
    }

    @Test func aDockedSheetShowsTheBoardAndItsTicket() {
        let r = Router()
        r.push(t("A-1"))
        r.dockSheet()
        #expect(shown(r) == board + ["A-1"])
        r.restoreDock()
        #expect(shown(r) == ["A-1"])
        r.dismissSheet()
        #expect(shown(r) == board)
    }

    @Test func aSheetBesideTheBoardShowsTheBoardAndItsTopTicket() {
        let r = Router()
        r.sheetIsBesideBoard = true
        r.push(t("A-1"))
        #expect(shown(r) == board + ["A-1"])
        r.push(t("A-2"))
        #expect(shown(r) == board + ["A-2"])
        // Docked beside it: the same; another section: just the ticket.
        r.dockSheet()
        #expect(shown(r) == board + ["A-2"])
        r.open(.tab(.settings))
        r.restoreDock()
        #expect(shown(r) == ["A-2"])
        // Narrowed: the sheet covers the board again.
        r.open(.tab(.board))
        r.restoreDock()
        r.sheetIsBesideBoard = false
        #expect(shown(r) == ["A-2"])
    }

    @Test func newSessionInTheSheetShowsNoTicket() {
        let r = Router()
        r.present(.newSession(projectId: nil, key: nil))
        #expect(r.ticketSheetState == .presented)
        #expect(shown(r).isEmpty)
        // Beside the board: just the board.
        r.sheetIsBesideBoard = true
        #expect(shown(r) == board)
    }

    @Test func theScannerCoversEverything() {
        let r = Router()
        r.present(.scan)
        #expect(shown(r).isEmpty)
    }

    // MARK: A ticket window

    @Test func aTicketWindowShowsItsTicketOrTheOnePushedOnIt() {
        let r = Router(ticket: t("W-1"))
        #expect(shown(r) == ["W-1"])
        r.push(t("W-2"))
        #expect(shown(r) == ["W-2"])
        r.show(t("W-3"))
        #expect(shown(r) == ["W-3"])
    }

    // MARK: Combining windows

    @Test func visibleWhileAnyWindowIsActiveWithTheForegroundWindowsTickets() {
        let p = PresenceRules.presence(deviceId: "d", scenes: [
            ScenePresence(phase: .inactive, tickets: ["B-2", "A-1"]),
            ScenePresence(phase: .active, tickets: ["A-1", "C-3"]),
            ScenePresence(phase: .background, tickets: ["Z-9"]),
        ])
        #expect(p == Presence(deviceId: "d", platform: .ios, visible: true, tickets: ["A-1", "B-2", "C-3"]))
    }

    @Test func hiddenOnceNoWindowIsActive() {
        let inactive = PresenceRules.presence(deviceId: "d", scenes: [ScenePresence(phase: .inactive, tickets: ["A-1"])])
        #expect(!inactive.visible)
        let background = PresenceRules.presence(deviceId: "d", scenes: [ScenePresence(phase: .background, tickets: ["A-1"])])
        #expect(background == Presence(deviceId: "d", platform: .ios, visible: false, tickets: []))
        #expect(!PresenceRules.presence(deviceId: "d", scenes: []).visible)
    }

    @Test func theTrackerSendsOnlyChangesAndForgetsClosedWindows() {
        var sent: [Presence] = []
        let tracker = PresenceTracker(deviceId: "d") { sent.append($0) }
        tracker.update("main", ScenePresence(phase: .active, tickets: ["B-1"]))
        tracker.update("main", ScenePresence(phase: .active, tickets: ["B-1"]))
        tracker.update("win", ScenePresence(phase: .inactive, tickets: ["W-1"]))
        tracker.update("main", ScenePresence(phase: .background, tickets: ["B-1"]))
        tracker.remove("win")
        tracker.remove("never-seen")
        #expect(sent == [
            Presence(deviceId: "d", platform: .ios, visible: true, tickets: ["B-1"]),
            Presence(deviceId: "d", platform: .ios, visible: true, tickets: ["B-1", "W-1"]),
            Presence(deviceId: "d", platform: .ios, visible: false, tickets: ["W-1"]),
            Presence(deviceId: "d", platform: .ios, visible: false, tickets: []),
        ])
    }
}

/// BoardStore and AppModel carry the presence to whichever socket is current.
@MainActor
@Suite("Presence delivery")
struct PresenceDeliveryTests {
    final class PresenceSocket: EventSource, PresenceChannel {
        let events: AsyncStream<HarnessEvent>
        let status: AsyncStream<Bool>
        private let eventsOut: AsyncStream<HarnessEvent>.Continuation
        private let statusOut: AsyncStream<Bool>.Continuation
        let got = Mutex<[Presence]>([])

        init() {
            (events, eventsOut) = AsyncStream.makeStream()
            (status, statusOut) = AsyncStream.makeStream()
        }

        func setPresence(_ presence: Presence) async { got.withLock { $0.append(presence) } }

        func close() async {
            eventsOut.finish()
            statusOut.finish()
        }

        var presences: [Presence] { got.withLock { $0 } }
    }

    private func p(_ visible: Bool, _ tickets: [String]) -> Presence {
        Presence(deviceId: "d", platform: .ios, visible: visible, tickets: tickets)
    }

    @Test func theStoreHandsItsPresenceToARebuiltSocket() async {
        var sockets: [PresenceSocket] = []
        let store = BoardStore(client: BoardStoreTests.FakeClient(), baseUrl: "http://mac:7717", makeSocket: {
            let s = PresenceSocket()
            sockets.append(s)
            return s
        }, timers: ManualTimers())
        store.start()
        store.setPresence(p(true, ["B", "A"]))
        store.setPresence(p(true, ["A", "B"]))
        #expect(await eventually { sockets[0].presences == [self.p(true, ["A", "B"])] })
        store.setPresence(p(false, ["A", "B"]))
        #expect(await eventually { sockets[0].presences.count == 2 })

        // Back from the background without a connection: a new socket, told the last presence.
        store.sceneDidEnterBackground()
        store.sceneBecameActive()
        #expect(sockets.count == 2)
        #expect(await eventually { sockets[1].presences == [self.p(false, ["A", "B"])] })
        store.close()
    }

    @Test func aStoreForAnotherServerStartsWithThePresence() async {
        var sockets: [PresenceSocket] = []
        let storage = AppModelTests.saved([AppModelTests.mac, AppModelTests.mini], tokens: ["srv-a": "ta", "srv-b": "tb"])
        let m = AppModel(storage: storage, probe: { _ in .ok(version: "1") }, makeStore: { active, _ in
            BoardStore(client: BoardStoreTests.FakeClient(), baseUrl: active.baseUrl, makeSocket: {
                let s = PresenceSocket()
                sockets.append(s)
                return s
            }, timers: ManualTimers())
        })
        m.load()
        m.setPresence(p(true, ["A-1"]))
        #expect(await eventually { sockets[0].presences == [self.p(true, ["A-1"])] })
        m.activate("srv-b")
        #expect(await eventually { sockets.count == 2 && sockets[1].presences == [self.p(true, ["A-1"])] })
        m.store?.close()
    }
}
