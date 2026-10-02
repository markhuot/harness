import Foundation
import Testing
@testable import HarnessKit

/// iPad ticket windows: which router a route lands on.
@MainActor
@Suite("Router and ticket windows")
struct RouterWindowTests {
    /// A main router opening tickets in windows, recording what it opened.
    private func windowed() -> (Router, () -> [Route]) {
        let r = Router()
        var opened: [Route] = []
        r.onOpenTicket = { opened.append($0) }
        r.setOpensTicketsInWindows(true)
        return (r, { opened })
    }

    @Test func aTicketOpensItsWindowInsteadOfPushing() {
        let (r, opened) = windowed()
        r.push(.ticket(key: "A-1", tab: .details))
        #expect(r.path(.board).isEmpty)
        #expect(opened() == [.ticket(key: "A-1", tab: .details)])
    }

    @Test func aTicketLinkLeavesTheMainWindowsSheetUp() {
        let (r, opened) = windowed()
        r.present(.newSession(projectId: nil, key: nil))
        r.open(.push(.ticket(key: "A-1", tab: nil)))
        #expect(r.sheet == .newSession(projectId: nil, key: nil))
        #expect(opened() == [.ticket(key: "A-1", tab: nil)])
        // Any other pushed link still dismisses it and pushes.
        r.open(.push(.prompts))
        #expect(r.sheet == nil)
        #expect(r.path(.board) == [.prompts])
        #expect(opened().count == 1)
    }

    @Test func withoutWindowModeOrAnOpenerTicketsPushAsBefore() {
        let r = Router()
        r.onOpenTicket = { _ in Issue.record("opened a window") }
        r.push(.ticket(key: "A-1", tab: nil))
        #expect(r.path(.board) == [.ticket(key: "A-1", tab: nil)])

        let bare = Router()
        bare.setOpensTicketsInWindows(true)
        bare.push(.ticket(key: "A-1", tab: nil))
        #expect(bare.path(.board) == [.ticket(key: "A-1", tab: nil)])

        // Narrowing again: back to pushing.
        let (w, opened) = windowed()
        w.setOpensTicketsInWindows(false)
        w.push(.ticket(key: "A-2", tab: nil))
        #expect(w.path(.board) == [.ticket(key: "A-2", tab: nil)] && opened().isEmpty)
    }

    @Test func aTicketWindowKeepsItsSheetsAndForwardsSectionLinks() {
        let w = Router(ticket: .ticket(key: "A-1", tab: nil))
        var forwarded: [DeepLink] = []
        w.onSectionLink = { forwarded.append($0) }
        w.onOpenTicket = { _ in Issue.record("a ticket window opened another window") }
        w.setOpensTicketsInWindows(true)
        w.present(.watcher(id: nil))
        #expect(w.sheet == .watcher(id: nil))
        var applied: ThemePicker.ThemePrefsPatch?
        #expect(w.open(url: URL(string: "harness://settings?theme=dark")!) { applied = $0 })
        #expect(forwarded.count == 1 && applied == ThemePicker.ThemePrefsPatch(theme: .dark))
        #expect(w.selectedTab == .board)
        // A pushed link dismisses its sheet and pushes inside the window, sub-tickets too.
        w.open(.push(.ticket(key: "A-2", tab: nil)))
        w.push(.file(FileRouteParams(path: "a.ts", ticket: "A-2")))
        #expect(w.sheet == nil)
        #expect(w.path(.board) == [.ticket(key: "A-2", tab: nil), .file(FileRouteParams(path: "a.ts", ticket: "A-2"))])
    }

    @Test func showingARouteResetsTheWindowsRootAndStack() {
        let w = Router(ticket: .ticket(key: "A-1", tab: nil))
        w.push(.ticket(key: "A-2", tab: nil))
        w.show(.ticket(key: "A-1", tab: .transcript))
        #expect(w.root == .ticket(key: "A-1", tab: .transcript))
        #expect(w.path(.board).isEmpty)
        // Only a ticket can be a window's root, and a main router has none.
        w.show(.prompts)
        #expect(w.root == .ticket(key: "A-1", tab: .transcript))
        let m = Router()
        m.show(.ticket(key: "A-1", tab: nil))
        #expect(m.root == nil)
    }

    @Test func replacingATicketSwapsItsScreenOrTheRoot() {
        let w = Router(ticket: .ticket(key: "JIRA-62", tab: nil))
        w.replaceTicket("JIRA-62", with: "A-1")
        #expect(w.root == .ticket(key: "A-1", tab: nil))
        #expect(w.path(.board).isEmpty)
        w.push(.ticket(key: "JIRA-7", tab: nil))
        w.replaceTicket("JIRA-7", with: "A-2")
        #expect(w.path(.board) == [.ticket(key: "A-2", tab: nil)])
        // No screen shows the key: the new one is pushed.
        w.replaceTicket("ZZ-1", with: "A-3")
        #expect(w.path(.board) == [.ticket(key: "A-2", tab: nil), .ticket(key: "A-3", tab: nil)])
        #expect(w.root == .ticket(key: "A-1", tab: nil))
    }

    @Test func removingTheRootTicketAsksTheWindowToClose() {
        let w = Router(ticket: .ticket(key: "A-1", tab: nil))
        w.push(.ticket(key: "A-2", tab: nil))
        #expect(w.removeTicket { $0 == "A-2" })
        #expect(w.path(.board).isEmpty && !w.closeRequested)
        #expect(!w.removeTicket { $0 == "B-1" })
        #expect(!w.closeRequested)
        #expect(w.removeTicket { $0 == "A-1" })
        #expect(w.closeRequested)
        // Reused for another link before it closed: it stays.
        w.show(.ticket(key: "A-1", tab: nil))
        #expect(!w.closeRequested)

        // The main window's stack: no root to fall back on.
        let m = Router()
        #expect(!m.removeTicket { $0 == "A-1" })
        #expect(!m.closeRequested)
    }
}

@Suite("TicketWindowValue")
struct TicketWindowValueTests {
    @Test func roundTripsThroughAnActivitysUserInfo() {
        let v = TicketWindowValue(key: "A-1", tab: .transcript)
        #expect(TicketWindowValue(userInfo: v.userInfo) == v)
        let bare = TicketWindowValue(key: "A-1", tab: nil)
        #expect(TicketWindowValue(userInfo: bare.userInfo) == bare)
    }

    @Test func rejectsAMissingKeyAndDropsABadTab() {
        #expect(TicketWindowValue(userInfo: nil) == nil)
        #expect(TicketWindowValue(userInfo: ["key": "  "]) == nil)
        #expect(TicketWindowValue(userInfo: ["tab": "details"]) == nil)
        #expect(TicketWindowValue(userInfo: ["key": "A-1", "tab": "nope"]) == TicketWindowValue(key: "A-1", tab: nil))
        #expect(TicketWindowValue(userInfo: ["key": "A-1", "tab": "plugin:git:changes"])?.tab == ChangesTab.normalize(TicketTab("plugin:git:changes")))
    }

    @Test func onlyATicketRouteMakesAValue() {
        #expect(TicketWindowValue(route: .prompts) == nil)
        #expect(TicketWindowValue(route: nil) == nil)
        #expect(TicketWindowValue(route: .ticket(key: "A-1", tab: .details))?.route == .ticket(key: "A-1", tab: .details))
    }

    @Test func theSceneMatchIsInNoLink() {
        for link in ["harness://ticket/A-1", "harness://board", "harness://inbox/x"] {
            #expect(!link.contains(TicketWindowValue.sceneMatch))
        }
    }
}
