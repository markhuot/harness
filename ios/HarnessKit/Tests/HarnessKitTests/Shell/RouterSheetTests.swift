import Foundation
import Testing
@testable import HarnessKit

/// iPhone ticket sheets: tickets and New session in a sheet that can dock under the tabs.
@MainActor
@Suite("Router and ticket sheets")
struct RouterSheetTests {
    private func sheeted() -> Router {
        let r = Router()
        r.setUsesTicketSheets(true)
        return r
    }

    private func t(_ key: String, _ tab: TicketTab? = nil) -> Route { .ticket(key: key, tab: tab) }
    private let draft = SheetRoute.newSession(projectId: "p1", key: nil)

    @Test func aTicketFromATabsRootOpensASheetAndLeavesTheStackAlone() {
        let r = sheeted()
        r.push(t("A-1", .spec))
        #expect(r.path(.board).isEmpty)
        #expect(r.ticketSheetState == .presented)
        #expect(r.ticketSheet?.root == .ticket(key: "A-1", tab: .spec))
        #expect(r.ticketSheet?.path == [])
        #expect(r.dock == nil)

        // From another tab, with screens on its stack: still a sheet.
        let s = sheeted()
        s.open(.tab(.settings))
        s.push(.prompts)
        s.push(t("A-2"))
        #expect(s.path(.settings) == [.prompts])
        #expect(s.ticketSheet?.root == .ticket(key: "A-2", tab: nil))
    }

    @Test func pushesWhileSheetedLandOnTheSheetsPath() {
        let r = sheeted()
        r.push(t("C-1"))
        r.push(t("C-2"))
        r.push(.file(FileRouteParams(path: "a.ts", ticket: "C-2")))
        #expect(r.ticketSheet?.path == [t("C-2"), .file(FileRouteParams(path: "a.ts", ticket: "C-2"))])
        #expect(r.path(.board).isEmpty)
        // A ticket link while sheeted pushes there too, and leaves the sheet up.
        r.open(.push(t("C-3")))
        #expect(r.ticketSheet?.path.last == t("C-3"))
        #expect(r.ticketSheet?.root == .ticket(key: "C-1", tab: nil))
    }

    @Test func pushingTheTicketOnTopDoesNothing() {
        let r = sheeted()
        r.push(t("C-1"))
        r.push(t("C-1", .details))
        #expect(r.ticketSheet?.path == [])
        r.push(t("C-2"))
        r.push(t("C-2"))
        #expect(r.ticketSheet?.path == [t("C-2")])
        // Not on top any more (a file above it): it pushes.
        r.push(.prompts)
        r.push(t("C-2"))
        #expect(r.ticketSheet?.path == [t("C-2"), .prompts, t("C-2")])
        // The root, under a pushed child, isn't on top either.
        r.push(t("C-1"))
        #expect(r.ticketSheet?.path.last == t("C-1"))
    }

    @Test func aLinkToATabOfTheTicketOnTopSwitchesToIt() {
        let r = sheeted()
        r.push(t("C-1", .spec))
        let id = r.ticketSheet!.id
        r.open(.push(t("C-1", .activity)))
        #expect(r.ticketSheet?.root == .ticket(key: "C-1", tab: .activity))
        #expect(r.ticketSheet?.path == [] && r.ticketSheet?.id == id)
        // A pushed child takes the tab in place; no tab leaves it as it is.
        r.push(t("C-2"))
        r.open(.push(t("C-2", .transcript)))
        #expect(r.ticketSheet?.path == [t("C-2", .transcript)])
        r.open(.push(t("C-2")))
        #expect(r.ticketSheet?.path == [t("C-2", .transcript)])
        // Docked: the link restores it on that tab.
        r.dockSheet()
        r.open(.push(t("C-2", .details)))
        #expect(r.ticketSheetState == .presented && r.ticketSheet?.id == id)
        #expect(r.ticketSheet?.path == [t("C-2", .details)])
        // A file on top: the ticket under it isn't on top, so its link pushes it.
        r.push(.prompts)
        r.open(.push(t("C-2", .spec)))
        #expect(r.ticketSheet?.path == [t("C-2", .details), .prompts, t("C-2", .spec)])
    }

    @Test func backAndPopToRootStayInTheSheet() {
        let r = sheeted()
        r.push(t("C-1"))
        r.push(t("C-2"))
        r.push(t("C-3"))
        r.setTicketSheetPath(Array(r.ticketSheet!.path.dropLast()))
        #expect(r.ticketSheet?.path == [t("C-2")])
        #expect(r.ticketSheet?.topTicketKey == "C-2")
        r.setTicketSheetPath([])
        #expect(r.ticketSheet?.topTicketKey == "C-1")
        #expect(r.ticketSheetState == .presented)
        // A docked sheet's path isn't the stack on screen: setting it does nothing.
        r.push(t("C-2"))
        r.dockSheet()
        r.setTicketSheetPath([])
        #expect(r.dock?.path == [t("C-2")])
    }

    @Test func dockingKeepsThePathAndRestoringBringsItBack() {
        let r = sheeted()
        r.push(t("C-1"))
        r.push(t("C-2"))
        r.push(.prompts)
        let id = r.ticketSheet!.id
        r.dockSheet()
        #expect(r.ticketSheetState == .docked)
        #expect(r.ticketSheet == nil)
        #expect(r.dock?.id == id)
        #expect(r.dock?.path == [t("C-2"), .prompts])
        r.restoreDock()
        #expect(r.ticketSheetState == .presented)
        #expect(r.dock == nil)
        #expect(r.ticketSheet?.id == id)
        #expect(r.ticketSheet?.root == .ticket(key: "C-1", tab: nil))
        #expect(r.ticketSheet?.path == [t("C-2"), .prompts])
        // Nothing to dock: stays gone.
        r.dismissSheet()
        r.dockSheet()
        #expect(r.ticketSheetState == .gone && r.dock == nil)
    }

    @Test func theDockIsTitledByTheTicketOnTop() {
        let r = sheeted()
        r.push(t("HARNESS-42"))
        r.dockSheet()
        #expect(r.dock?.title == "HARNESS-42")
        r.restoreDock()
        r.push(t("HARNESS-43"))
        r.push(.file(FileRouteParams(path: "a.ts", ticket: "HARNESS-43")))
        r.dockSheet()
        // A file above the child: the child is still the ticket on top.
        #expect(r.dock?.title == "HARNESS-43")
        r.restoreDock()
        r.setTicketSheetPath([])
        r.dockSheet()
        #expect(r.dock?.title == "HARNESS-42")

        let n = sheeted()
        n.present(draft)
        n.dockSheet()
        #expect(n.dock?.title == "New session")
        #expect(n.dock?.topTicketKey == nil)
    }

    @Test func dismissingClearsItFromEitherState() {
        let r = sheeted()
        r.push(t("C-1"))
        r.dismissSheet()
        #expect(r.ticketSheetState == .gone && r.ticketSheet == nil && r.dock == nil)
        r.push(t("C-1"))
        r.dockSheet()
        r.dismissSheet()
        #expect(r.ticketSheetState == .gone && r.dock == nil)
        // Restoring after a dismiss brings nothing back.
        r.restoreDock()
        #expect(r.ticketSheet == nil)
        // With no sheet up, a non-ticket push goes on the stack as before.
        r.push(.prompts)
        #expect(r.path(.board) == [.prompts])
    }

    @Test func openingSomethingElseReplacesTheDock() {
        let r = sheeted()
        r.push(t("C-1"))
        r.push(t("C-2"))
        r.dockSheet()
        let docked = r.dock!.id
        r.push(t("D-1"))
        #expect(r.ticketSheetState == .presented)
        #expect(r.dock == nil)
        #expect(r.ticketSheet?.root == .ticket(key: "D-1", tab: nil))
        #expect(r.ticketSheet?.path == [])
        #expect(r.ticketSheet?.id != docked)

        // New session over a docked ticket replaces it too.
        r.dockSheet()
        r.present(draft)
        #expect(r.dock == nil)
        #expect(r.ticketSheet?.root == .newSession(projectId: "p1", key: nil))
        #expect(r.sheet == nil)
    }

    @Test func openingTheDockedTicketRestoresIt() {
        let r = sheeted()
        r.push(t("C-1"))
        r.push(t("C-2"))
        r.dockSheet()
        let id = r.dock!.id
        // The ticket on top (the dock's title) restores, path and all.
        r.open(.push(t("C-2")))
        #expect(r.ticketSheet?.id == id)
        #expect(r.ticketSheet?.path == [t("C-2")])
        // The root under a pushed child isn't what the dock shows: it opens a fresh sheet.
        r.dockSheet()
        r.push(t("C-1"))
        #expect(r.ticketSheet?.id != id)
        #expect(r.ticketSheet?.path == [])

        // The same New session restores; another one replaces it.
        let n = sheeted()
        n.present(draft)
        n.dockSheet()
        let draftID = n.dock!.id
        n.present(draft)
        #expect(n.ticketSheet?.id == draftID)
        n.dockSheet()
        n.present(.newSession(projectId: "p2", key: nil))
        #expect(n.ticketSheet?.id != draftID)
        #expect(n.ticketSheet?.root == .newSession(projectId: "p2", key: nil))
    }

    @Test func openingSomethingWhilePresentedReplacesTheContent() {
        let r = sheeted()
        r.push(t("C-1"))
        r.push(t("C-2"))
        let id = r.ticketSheet!.id
        r.present(draft)
        #expect(r.ticketSheet?.id == id)
        #expect(r.ticketSheet?.root == .newSession(projectId: "p1", key: nil))
        #expect(r.ticketSheet?.path == [])
        // A ticket pushed on New session takes its place rather than stacking on the editor.
        r.push(t("D-1"))
        #expect(r.ticketSheet?.root == .ticket(key: "D-1", tab: nil))
        #expect(r.ticketSheet?.path == [])
        #expect(r.ticketSheet?.id == id)
    }

    @Test func aLaunchedNewSessionBecomesTheTicketsSheet() {
        let r = sheeted()
        r.present(draft)
        let id = r.ticketSheet!.id
        r.replace(draft, with: t("A-1", .transcript))
        #expect(r.ticketSheetState == .presented)
        #expect(r.ticketSheet?.id == id)
        #expect(r.ticketSheet?.root == .ticket(key: "A-1", tab: .transcript))
        #expect(r.sheet == nil && r.path(.board).isEmpty)

        // Launched after being docked: it stays docked, now as the ticket.
        let d = sheeted()
        d.present(draft)
        d.dockSheet()
        d.replace(draft, with: t("A-2"))
        #expect(d.dock?.title == "A-2")
        #expect(d.ticketSheet == nil)

        // Something else replaced it first: the ticket is pushed (onto that sheet).
        let o = sheeted()
        o.present(draft)
        o.push(t("B-1"))
        o.replace(draft, with: t("A-3"))
        #expect(o.ticketSheet?.root == .ticket(key: "B-1", tab: nil))
        #expect(o.ticketSheet?.path == [t("A-3")])
    }

    @Test func closingNewSessionDismissesOnlyItsOwnSheet() {
        let r = sheeted()
        r.present(draft)
        r.close(.newSession(projectId: "p2", key: nil))
        #expect(r.ticketSheetState == .presented)
        r.close(draft)
        #expect(r.ticketSheetState == .gone)
        // Replaced by a ticket: closing the draft leaves the ticket.
        r.present(draft)
        r.push(t("A-1"))
        r.close(draft)
        #expect(r.ticketSheet?.root == .ticket(key: "A-1", tab: nil))
        // The other sheets still close as before.
        r.present(.watcher(id: nil))
        r.close(.watcher(id: nil))
        #expect(r.sheet == nil && r.ticketSheetState == .presented)
    }

    @Test func otherSheetsAndCoversWorkAsBefore() {
        let r = sheeted()
        r.push(t("A-1"))
        r.present(.projects)
        #expect(r.sheet == .projects)
        #expect(r.ticketSheetState == .presented)
        r.present(.scan)
        #expect(r.cover == .scan)
        // A pushed link closes those, not the ticket sheet, and lands in it.
        r.open(.push(.prompts))
        #expect(r.sheet == nil && r.cover == nil)
        #expect(r.ticketSheet?.path == [.prompts])
    }

    @Test func aTabLinkDocksThePresentedSheetAndKeepsTheDock() {
        let r = sheeted()
        r.push(t("A-1"))
        r.push(t("A-2"))
        r.present(.projects)
        r.open(.tab(.inbox))
        #expect(r.selectedTab == .inbox)
        #expect(r.sheet == nil)
        #expect(r.ticketSheetState == .docked)
        #expect(r.dock?.path == [t("A-2")])
        r.open(.tab(.board))
        #expect(r.dock?.title == "A-2")
        // Non-ticket pushes on a tab with the dock up go on the tab's stack.
        r.push(.prompts)
        #expect(r.path(.board) == [.prompts] && r.dock != nil)
    }

    @Test func removingAndReplacingTicketsReachIntoTheSheet() {
        let r = sheeted()
        r.push(t("A-1"))
        r.push(t("JIRA-7"))
        r.replaceTicket("JIRA-7", with: "A-2")
        #expect(r.ticketSheet?.path == [t("A-2")])
        r.replaceTicket("A-1", with: "A-9")
        #expect(r.ticketSheet?.root == .ticket(key: "A-9", tab: nil))
        // Not shown anywhere: pushed, onto the sheet.
        r.replaceTicket("ZZ-1", with: "A-3")
        #expect(r.ticketSheet?.path == [t("A-2"), t("A-3")])

        #expect(r.removeTicket { $0 == "A-3" })
        #expect(r.ticketSheet?.path == [t("A-2")])
        #expect(!r.removeTicket { $0 == "B-1" })
        // The root goes: the whole sheet goes, docked or not.
        r.dockSheet()
        #expect(r.removeTicket { $0 == "A-9" })
        #expect(r.ticketSheetState == .gone)
    }

    @Test func aDockWaitingOutAWideSpellDoesntSwallowTheVisibleStacksChanges() {
        let r = sheeted()
        r.push(t("A-1"))
        r.dockSheet()
        r.setUsesTicketSheets(false)
        // At regular width the same ticket is opened on the stack, over the hidden dock.
        r.push(t("A-1"))
        #expect(r.path(.board) == [t("A-1")])
        r.replaceTicket("A-1", with: "A-2")
        #expect(r.path(.board) == [t("A-2")])
        #expect(r.removeTicket { $0 == "A-2" })
        #expect(r.path(.board).isEmpty)
        // Kept but not drawn while wide, so the sections don't keep clear of it.
        #expect(r.dock != nil && !r.showsDock)
        // The dock is still there for the next narrow spell.
        r.setUsesTicketSheets(true)
        #expect(r.dock?.title == "A-1")
        #expect(r.showsDock)
        r.restoreDock()
        #expect(!r.showsDock)
    }

    @Test func withTheFlagOffTicketsPushAsBefore() {
        let r = Router()
        r.push(t("A-1"))
        r.present(draft)
        #expect(r.path(.board) == [t("A-1")])
        #expect(r.sheet == draft)
        #expect(r.ticketSheetState == .gone)
        r.replace(draft, with: t("A-2"))
        #expect(r.sheet == nil && r.path(.board) == [t("A-1"), t("A-2")])

        // A ticket window ignores the flag.
        let w = Router(ticket: t("A-1"))
        w.setUsesTicketSheets(true)
        #expect(!w.usesTicketSheets)
        w.push(t("A-2"))
        #expect(w.path(.board) == [t("A-2")] && w.ticketSheet == nil)
    }

    @Test func windowsModeStillOpensTicketsInWindows() {
        let r = Router()
        var opened: [Route] = []
        r.onOpenTicket = { opened.append($0) }
        r.setOpensTicketsInWindows(true)
        r.setUsesTicketSheets(true)
        r.push(t("A-1"))
        #expect(opened == [t("A-1")])
        #expect(r.ticketSheetState == .gone && r.path(.board).isEmpty)
    }

    @Test func narrowingAndWideningMovesScreensBetweenTheStackAndTheSheet() {
        let r = Router()
        r.push(.prompts)
        r.push(t("A-1"))
        r.push(t("A-2"))
        r.setUsesTicketSheets(true)
        #expect(r.path(.board) == [.prompts])
        #expect(r.ticketSheet?.root == .ticket(key: "A-1", tab: nil))
        #expect(r.ticketSheet?.path == [t("A-2")])
        r.setUsesTicketSheets(false)
        #expect(r.path(.board) == [.prompts, t("A-1"), t("A-2")])
        #expect(r.ticketSheetState == .gone)

        // New session moves between `sheet` and the ticket sheet.
        let n = Router()
        n.present(draft)
        n.setUsesTicketSheets(true)
        #expect(n.sheet == nil && n.ticketSheet?.root == .newSession(projectId: "p1", key: nil))
        n.setUsesTicketSheets(false)
        #expect(n.sheet == draft && n.ticketSheetState == .gone)

        // A dock waits out the wide spell.
        let d = sheeted()
        d.push(t("A-1"))
        d.dockSheet()
        d.setUsesTicketSheets(false)
        d.setUsesTicketSheets(true)
        #expect(d.dock?.title == "A-1")
    }
}
