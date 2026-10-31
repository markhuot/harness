import Foundation
import Testing
import HarnessKit

/// A New session sheet names its draft once the first save makes it, so a sheet that mounts again
/// (restored from the dock, a relaunch) reopens the draft instead of starting a blank one.
@MainActor @Suite struct RouterNewSessionDraftTests {
    private let blank = TicketSheet.Root.newSession(projectId: "p1", key: nil)
    private let saved = TicketSheet.Root.newSession(projectId: "p1", key: "A-7")

    private func savedNewSession() -> Router {
        let r = Router()
        r.present(.newSession(projectId: "p1", key: nil))
        r.newSessionSaved(projectId: "p1", key: "A-7")
        return r
    }

    @Test func aDockedNewSessionComesBackNamingItsSavedDraft() {
        let r = savedNewSession()
        r.dockSheet()
        r.restoreDock()
        #expect(r.ticketSheet?.root == saved)
    }

    @Test func theDraftKeyOutlivesARelaunch() {
        let r = savedNewSession()
        r.dockSheet()
        let fresh = Router()
        fresh.restorePersistedState(r.persistedState())
        #expect(fresh.dock?.root == saved)
    }

    @Test func aLaterSaveNeverNamesAnotherBlankNewSession() {
        let r = savedNewSession()
        r.dockSheet()
        r.present(.newSession(projectId: "p1", key: nil))
        #expect(r.dockedSheets.count == 2)
        r.newSessionSaved(projectId: "p1", key: "A-7")
        #expect(r.dockedSheets.map(\.root) == [blank, saved])
    }

    @Test func theDraftOpenedFromTheBoardBringsTheDockedSheetForward() {
        let r = savedNewSession()
        r.dockSheet()
        r.present(.newSession(projectId: nil, key: "A-7"))
        #expect(r.dockedSheets.count == 1)
        #expect(r.ticketSheet?.root == saved)
    }

    @Test func theNamedSheetLaunchesAndClosesByItsDraft() {
        let launched = savedNewSession()
        launched.replace(.newSession(projectId: "p1", key: "A-7"), with: .ticket(key: "A-7", tab: nil))
        #expect(launched.ticketSheet?.root == .ticket(key: "A-7", tab: nil))

        let closed = savedNewSession()
        closed.close(.newSession(projectId: "p1", key: "A-7"))
        #expect(closed.ticketSheetState == .gone)
    }

    @Test func aTicketWindowsNewSessionClosesOnceItsDraftIsNamed() {
        let r = Router(ticket: .ticket(key: "A-1", tab: nil))
        r.present(.newSession(projectId: "p1", key: nil))
        #expect(r.sheet == .newSession(projectId: "p1", key: nil))
        r.close(.newSession(projectId: "p2", key: "A-7"))
        #expect(r.sheet != nil)
        r.close(.newSession(projectId: "p1", key: "A-7"))
        #expect(r.sheet == nil)
    }
}
