import Foundation
import Testing
@testable import HarnessKit

/// The docked tickets survive a relaunch: saved on the device, restored docked.
@MainActor
@Suite("Router dock across launches")
struct RouterDockPersistenceTests {
    private func t(_ key: String, _ tab: TicketTab? = nil) -> Route { .ticket(key: key, tab: tab) }

    @Test func theDockRoundTripsDockedWithItsOrderAndPaths() {
        let r = Router()
        r.openTicket(key: "A-1", tab: .spec)
        r.push(t("A-2", .transcript))
        r.push(.file(FileRouteParams(path: "a.ts", ticket: "A-2", start: "3")))
        r.present(.newSession(projectId: "p1", key: nil))
        r.openTicket(key: "B-1", tab: nil)
        // Presented when saved: it still comes back docked.
        let defaults = MemoryChangesDefaults()
        r.savePersistedDock(to: defaults)

        let back = Router()
        back.restorePersistedDock(from: defaults)
        #expect(back.ticketSheetState == .docked)
        #expect(back.dockedSheets.map(\.root) == r.dockedSheets.map(\.root))
        #expect(back.dockedSheets.map(\.path) == r.dockedSheets.map(\.path))
        #expect(back.dock?.title == "B-1")
        // Fresh ids, still unique, and new sheets don't collide with them.
        #expect(Set(back.dockedSheets.map(\.id)).count == 3)
        back.openTicket(key: "C-1", tab: nil)
        #expect(Set(back.dockedSheets.map(\.id)).count == 4)
    }

    @Test func anEmptyDockSavesNothingAndRestoresNothing() {
        let r = Router()
        let defaults = MemoryChangesDefaults([Router.persistedDockKey: "[]"])
        r.openTicket(key: "A-1", tab: nil)
        r.dismissSheet()
        r.savePersistedDock(to: defaults)
        #expect(defaults.string(forKey: Router.persistedDockKey) == "")
        let back = Router()
        back.restorePersistedDock(from: defaults)
        #expect(back.ticketSheetState == .gone)
    }

    @Test func undecodableEntriesDropAndTheRestRestore() {
        // An entry with an unknown root, one with a route this build doesn't know in its path (kept up
        // to it), and a good one.
        let json = """
        [{"root":{"someday":{}},"path":[]},
         {"root":{"ticket":{"key":"A-1"}},"path":[{"ticket":{"key":"A-2"}},{"hologram":{"id":"x"}},{"prompts":{}}]},
         {"root":{"newSession":{"projectId":"p1"}},"path":[]}]
        """
        let r = Router()
        r.restorePersistedDock(json)
        #expect(r.dockedSheets.map(\.root) == [.ticket(key: "A-1", tab: nil), .newSession(projectId: "p1", key: nil)])
        #expect(r.dockedSheets.first?.path == [t("A-2")])
        #expect(r.ticketSheetState == .docked)

        // Garbage, or nothing: nothing, without a crash.
        for junk in ["", "{", "{\"root\":1}", "[1,2]", "null"] {
            let g = Router()
            g.restorePersistedDock(junk)
            #expect(g.ticketSheetState == .gone)
        }
    }

    @Test func restoringNeverClobbersSheetsAlreadyOpenOrATicketWindow() {
        let saved = Router()
        saved.openTicket(key: "A-1", tab: nil)
        let json = saved.persistedDock

        let r = Router()
        r.openTicket(key: "B-1", tab: nil)
        r.restorePersistedDock(json)
        #expect(r.dockedSheets.map(\.title) == ["B-1"] && r.ticketSheetState == .presented)

        let w = Router(ticket: t("C-1"))
        w.restorePersistedDock(json)
        #expect(w.ticketSheetState == .gone)
    }
}
