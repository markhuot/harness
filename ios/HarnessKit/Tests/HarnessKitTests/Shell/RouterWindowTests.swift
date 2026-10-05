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

    @Test func aLaunchedNewSessionClosesItsSheetAndOpensTheTicketsWindow() {
        let (r, opened) = windowed()
        let sheet = SheetRoute.newSession(projectId: nil, key: nil)
        r.present(sheet)
        r.replace(sheet, with: .ticket(key: "A-1", tab: .transcript))
        #expect(r.sheet == nil)
        #expect(r.path(.board).isEmpty)
        #expect(opened() == [.ticket(key: "A-1", tab: .transcript)])

        // A sheet a link already swapped in stays up.
        r.present(.watcher(id: nil))
        r.replace(sheet, with: .ticket(key: "A-2", tab: nil))
        #expect(r.sheet == .watcher(id: nil))
        #expect(opened().last == .ticket(key: "A-2", tab: nil))

        // Pushing instead (iPhone): the sheet closes and the ticket lands on the stack.
        let p = Router()
        p.present(sheet)
        p.replace(sheet, with: .ticket(key: "A-3", tab: nil))
        #expect(p.sheet == nil && p.path(.board) == [.ticket(key: "A-3", tab: nil)])
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

    @Test func pinnedWindowsRoundTripThroughUserInfo() {
        let values: [TicketWindowValue] = [
            .pinned("A-1", .transcript), .pinned("A-1", .browser), .pinned("A-1", .browser, browserTab: 3),
            .pinned("A-1", TicketWindowValue.composer), .pinned("A-1", "plugin:x:y"),
        ]
        for v in values {
            #expect(TicketWindowValue(userInfo: v.userInfo) == v, "\(v)")
        }
        #expect(TicketWindowValue.pinned("A-1", .browser, browserTab: 3).userInfo == ["key": "A-1", "tab": "browser", "pinned": "1", "browserTab": "3"])
    }

    @Test func theComposerIsOnlyEverAPinnedWindow() {
        // A full window asked for the composer opens on the default tab instead.
        #expect(TicketWindowValue(key: "A-1", tab: TicketWindowValue.composer).tab == nil)
        #expect(TicketWindowValue(userInfo: ["key": "A-1", "tab": "composer"]) == TicketWindowValue(key: "A-1", tab: nil))
        #expect(TicketWindowValue(userInfo: ["key": "A-1", "tab": "composer", "pinned": "1"])?.tab == TicketWindowValue.composer)
        // Its route is the ticket on its default tab: there is no composer tab to link to.
        #expect(TicketWindowValue.pinned("A-1", TicketWindowValue.composer).route == .ticket(key: "A-1", tab: nil))
    }

    @Test func aPinnedValueNeedsATabAndOnlyTheBrowserKeepsABrowserTab() {
        #expect(!TicketWindowValue(key: "A-1", tab: nil, pinned: true).pinned)
        #expect(TicketWindowValue(userInfo: ["key": "A-1", "pinned": "1"]) == TicketWindowValue(key: "A-1", tab: nil))
        #expect(TicketWindowValue(userInfo: ["key": "A-1", "tab": "nope", "pinned": "1"])?.pinned == false)
        #expect(TicketWindowValue.pinned("A-1", .spec, browserTab: 2).browserTab == nil)
        #expect(TicketWindowValue(key: "A-1", tab: .browser, browserTab: 2).browserTab == nil)
        #expect(TicketWindowValue(userInfo: ["key": "A-1", "tab": "browser", "pinned": "1", "browserTab": "x"])?.browserTab == nil)
    }

    @Test func identityIsTheTicketForAFullWindowAndTheTabForAPinnedOne() {
        let full = TicketWindowValue(key: "a-1", tab: .spec)
        #expect(full.sameWindow(as: TicketWindowValue(key: "A-1", tab: .transcript)))
        #expect(!full.sameWindow(as: .pinned("A-1", .spec)))
        #expect(TicketWindowValue.pinned("a-1", .spec).sameWindow(as: .pinned("A-1", .spec)))
        #expect(!TicketWindowValue.pinned("A-1", .spec).sameWindow(as: .pinned("A-1", .transcript)))
        #expect(!TicketWindowValue.pinned("A-1", .spec).sameWindow(as: .pinned("A-2", .spec)))
        #expect(!TicketWindowValue.pinned("A-1", .browser).sameWindow(as: .pinned("A-1", .browser, browserTab: 1)))
        #expect(!TicketWindowValue.pinned("A-1", .browser, browserTab: 1).sameWindow(as: .pinned("A-1", .browser, browserTab: 2)))
        #expect(TicketWindowValue.pinned("A-1", .browser, browserTab: 1).sameWindow(as: .pinned("A-1", .browser, browserTab: 1)))
    }

    @Test func aValueSavedBeforePinnedWindowsDecodesAsAFullWindow() throws {
        let old = try JSONDecoder().decode(TicketWindowValue.self, from: Data(#"{"key":"A-1","tab":"details"}"#.utf8))
        #expect(old == TicketWindowValue(key: "A-1", tab: .details))
        let v = TicketWindowValue.pinned("A-1", .browser, browserTab: 4)
        #expect(try JSONDecoder().decode(TicketWindowValue.self, from: JSONEncoder().encode(v)) == v)
    }

    @Test func theSceneMatchIsInNoLink() {
        for link in ["harness://ticket/A-1", "harness://board", "harness://inbox/x"] {
            #expect(!link.contains(TicketWindowValue.sceneMatch))
        }
    }
}

@Suite("TornOffTabs")
struct TornOffTabsTests {
    @Test func collectsOneTicketsPinnedWindows() {
        let open: [TicketWindowValue] = [
            TicketWindowValue(key: "A-1", tab: .transcript), // the full window: not torn off
            .pinned("a-1", .transcript), .pinned("A-1", .browser, browserTab: 2), .pinned("A-1", TicketWindowValue.composer),
            .pinned("A-2", .spec), .pinned("A-10", .details),
        ]
        let t = TornOffTabs(open, key: "A-1")
        #expect(t.tabs == [.transcript])
        #expect(t.browserTabs == [2])
        #expect(t.composer)
        #expect(!t.isEmpty)
        #expect(TornOffTabs(open, key: "A-3").isEmpty)
        #expect(TornOffTabs(open, key: "A-2").tabs == [.spec])
    }

    @Test func aWholeBrowserTabIsATabAndAPinnedBrowserTabIsNot() {
        let whole = TornOffTabs([.pinned("A-1", .browser)], key: "A-1")
        #expect(whole.tabs == [.browser] && whole.browserTabs.isEmpty)
        #expect(whole.window("A-1", tab: .browser) == .pinned("A-1", .browser))
        let one = TornOffTabs([.pinned("A-1", .browser, browserTab: 5)], key: "A-1")
        #expect(one.tabs.isEmpty)
        #expect(one.window("A-1", tab: .browser) == nil)
        #expect(one.window("A-1", tab: .browser, browserTab: 5) == .pinned("A-1", .browser, browserTab: 5))
        #expect(one.window("A-1", tab: .browser, browserTab: 6) == nil)
    }

    @Test func windowNamesThePinnedWindowToCloseOrNil() {
        let t = TornOffTabs([.pinned("A-1", .spec), .pinned("A-1", TicketWindowValue.composer)], key: "A-1")
        #expect(t.window("A-1", tab: .spec) == .pinned("A-1", .spec))
        #expect(t.window("A-1", tab: TicketWindowValue.composer) == .pinned("A-1", TicketWindowValue.composer))
        #expect(t.window("A-1", tab: .activity) == nil)
        #expect(TornOffTabs.none.window("A-1", tab: TicketWindowValue.composer) == nil)
    }
}

@Suite("TornOffTabs names")
struct TornOffNameTests {
    @Test func namesEachKindOfTornOffThing() {
        #expect(TornOffTabs.name(.transcript) == "Transcript")
        #expect(TornOffTabs.name(.children) == "Tickets")
        #expect(TornOffTabs.name(.changes) == "Changes")
        #expect(TornOffTabs.name(TicketWindowValue.composer) == "Message")
        #expect(TornOffTabs.name(.browser) == "Browser")
        #expect(TornOffTabs.name(.browser, browserTab: 3) == "Browser tab 3")
        #expect(TornOffTabs.name(.browser, browserTab: 3, browserTabLabel: "Docs") == "Docs")
        let plugins = [PluginTab(pluginId: "notes", id: "board", title: "Notes board", when: .always)]
        #expect(TornOffTabs.name("plugin:notes:board", pluginTabs: plugins) == "Notes board")
        #expect(TornOffTabs.name("plugin:notes:board") == "board")
    }

    @Test func aPinnedWindowIsTitledByItsTabAndAFullOneByItsKey() {
        #expect(TornOffTabs.windowTitle(TicketWindowValue(key: "A-1", tab: .spec)) == "A-1")
        #expect(TornOffTabs.windowTitle(.pinned("A-1", .spec)) == "A-1 · Spec")
        #expect(TornOffTabs.windowTitle(.pinned("A-1", .browser, browserTab: 2)) == "A-1 · Browser tab 2")
    }
}
