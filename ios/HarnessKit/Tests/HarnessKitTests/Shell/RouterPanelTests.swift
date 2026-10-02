import Foundation
import Testing
@testable import HarnessKit

/// The iPad's slide-over panel and ticket windows: which router a route lands on.
@MainActor
@Suite("Router panel and ticket windows")
struct RouterPanelTests {
    private func panelRouter() -> Router {
        let r = Router()
        r.setOpensTicketsInPanel(true)
        return r
    }

    @Test func aTicketOpensInThePanelInsteadOfPushing() {
        let r = panelRouter()
        r.open(.push(.ticket(key: "A-1", tab: .details)))
        #expect(r.path(.board).isEmpty)
        #expect(r.panel?.root == .ticket(key: "A-1", tab: .details))
        #expect(r.panel?.host === r)
    }

    @Test func anotherTicketReplacesThePanelAndItsStack() {
        let r = panelRouter()
        r.push(.ticket(key: "A-1", tab: nil))
        let first = r.panel
        first?.push(.file(FileRouteParams(path: "a.ts", ticket: "A-1")))
        r.push(.ticket(key: "A-2", tab: nil))
        #expect(r.panel !== first)
        #expect(r.panel?.root == .ticket(key: "A-2", tab: nil))
        #expect(r.panel?.path(.board).isEmpty == true)
    }

    @Test func otherRoutesStillPushOnTheSectionWithThePanelUp() {
        let r = panelRouter()
        r.push(.ticket(key: "A-1", tab: nil))
        r.open(.tab(.settings))
        #expect(r.panel == nil)
        r.push(.ticket(key: "A-1", tab: nil))
        // A tap inside the section (Settings → project) leaves the panel be.
        r.push(.project(id: "p1"))
        #expect(r.path(.settings) == [.project(id: "p1")])
        #expect(r.panel != nil)
        // A link to a pushed screen takes the panel down, like a modal.
        r.open(.push(.prompts))
        #expect(r.panel == nil)
        #expect(r.path(.settings) == [.project(id: "p1"), .prompts])
    }

    @Test func withoutPanelModeTicketsPushAsBefore() {
        let r = Router()
        r.push(.ticket(key: "A-1", tab: nil))
        #expect(r.panel == nil)
        #expect(r.path(.board) == [.ticket(key: "A-1", tab: nil)])
    }

    @Test func insideThePanelTicketsAndFilesPushOnItsOwnStack() {
        let r = panelRouter()
        r.push(.ticket(key: "A-1", tab: nil))
        let p = r.panel!
        p.push(.ticket(key: "A-2", tab: .children))
        p.open(.push(.file(FileRouteParams(path: "a.ts", ticket: "A-2"))))
        #expect(p.path(.board) == [.ticket(key: "A-2", tab: .children), .file(FileRouteParams(path: "a.ts", ticket: "A-2"))])
        #expect(r.path(.board).isEmpty)
        #expect(r.panel === p)
    }

    @Test func thePanelHandsSheetsAndSectionLinksToTheMainWindow() {
        let r = panelRouter()
        r.push(.ticket(key: "A-1", tab: nil))
        let p = r.panel!
        p.present(.newSession(projectId: nil, key: "A-1"))
        #expect(r.sheet == .newSession(projectId: nil, key: "A-1"))
        #expect(p.sheet == nil)
        var applied: ThemePicker.ThemePrefsPatch?
        #expect(p.open(url: URL(string: "harness://settings?theme=dark")!) { applied = $0 })
        #expect(applied == ThemePicker.ThemePrefsPatch(theme: .dark))
        #expect(r.selectedTab == .settings && r.sheet == nil && r.panel == nil)
    }

    @Test func aTicketWindowKeepsItsSheetsAndForwardsSectionLinks() {
        let w = Router(ticket: .ticket(key: "A-1", tab: nil))
        var forwarded: [DeepLink] = []
        w.onSectionLink = { forwarded.append($0) }
        w.present(.watcher(id: nil))
        #expect(w.sheet == .watcher(id: nil))
        w.open(.tab(.inbox))
        #expect(forwarded == [.tab(.inbox)])
        // A pushed link dismisses its sheet and pushes inside the window, never into panel mode.
        w.open(.push(.ticket(key: "A-2", tab: nil)))
        #expect(w.sheet == nil && w.panel == nil)
        #expect(w.path(.board) == [.ticket(key: "A-2", tab: nil)])
    }

    @Test func narrowingMovesThePanelOntoTheSectionStack() {
        let r = panelRouter()
        r.open(.tab(.inbox))
        r.push(.triage(sessionId: "s1"))
        r.push(.ticket(key: "A-1", tab: .transcript))
        r.panel?.push(.ticket(key: "A-2", tab: nil))
        r.setOpensTicketsInPanel(false)
        #expect(r.panel == nil)
        #expect(r.path(.inbox) == [.triage(sessionId: "s1"), .ticket(key: "A-1", tab: .transcript), .ticket(key: "A-2", tab: nil)])
        r.push(.ticket(key: "A-3", tab: nil))
        #expect(r.path(.inbox).last == .ticket(key: "A-3", tab: nil))
    }

    @Test func detachingClosesThePanelOnItsTopTicket() {
        let r = panelRouter()
        #expect(r.detachPanel() == nil)
        r.push(.ticket(key: "A-1", tab: nil))
        r.panel?.push(.ticket(key: "A-2", tab: .details))
        r.panel?.push(.file(FileRouteParams(path: "a.ts", ticket: "A-2")))
        #expect(r.detachPanel() == .ticket(key: "A-2", tab: .details))
        #expect(r.panel == nil)
        r.push(.ticket(key: "A-3", tab: nil))
        #expect(r.detachPanel() == .ticket(key: "A-3", tab: nil))
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

    @Test func removingTheRootTicketClosesThePanelOrAsksTheWindowToClose() {
        let r = panelRouter()
        r.push(.ticket(key: "A-1", tab: nil))
        let p = r.panel!
        p.push(.ticket(key: "A-2", tab: nil))
        #expect(p.removeTicket { $0 == "A-2" })
        #expect(p.path(.board).isEmpty && r.panel === p)
        #expect(p.removeTicket { $0 == "A-1" })
        #expect(r.panel == nil)

        let w = Router(ticket: .ticket(key: "A-1", tab: nil))
        #expect(!w.removeTicket { $0 == "B-1" })
        #expect(!w.closeRequested)
        #expect(w.removeTicket { $0 == "A-1" })
        #expect(w.closeRequested)

        // The main window's stack: no root to fall back on.
        let m = Router()
        #expect(!m.removeTicket { $0 == "A-1" })
    }

    @Test func aStalePanelClosingLeavesTheNewOneUp() {
        let r = panelRouter()
        r.push(.ticket(key: "A-1", tab: nil))
        let old = r.panel!
        r.push(.ticket(key: "A-2", tab: nil))
        #expect(old.removeTicket { $0 == "A-1" })
        #expect(r.panel?.root == .ticket(key: "A-2", tab: nil))
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
