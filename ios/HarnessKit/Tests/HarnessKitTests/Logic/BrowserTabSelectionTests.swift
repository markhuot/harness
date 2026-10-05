import Testing
@testable import HarnessKit

private func state(_ tabId: Int?, tabs: [BrowserTab]? = nil) -> BrowserState {
    BrowserState(sessionId: "ses_1", tabId: tabId, url: "about:blank", title: "", loading: false, tabs: tabs)
}

private func tab(_ id: Int, _ url: String = "about:blank", _ title: String = "") -> BrowserTab {
    BrowserTab(id: id, url: url, title: title, loading: false)
}

@Suite("BrowserTabSelection")
struct BrowserTabSelectionTests {
    @Test func learningTheFirstTabIsNotAMove() {
        var s = BrowserTabSelection()
        #expect(s.receive(state(1)) == false)
        #expect(s.shown == 1)
        #expect(s.receive(state(1)) == false)
        // The service moved the socket (newTab, or the watched tab closed).
        #expect(s.receive(state(4)) == true)
        #expect(s.shown == 4)
    }

    @Test func aServiceWithoutTabsNeverMoves() {
        var s = BrowserTabSelection(shown: 2)
        #expect(s.receive(state(nil)) == false)
        #expect(s.shown == 2)
        #expect(s.accepts(frameTabId: nil))
    }

    @Test func selectSwitchesOnlyToAnotherTab() {
        var s = BrowserTabSelection()
        _ = s.receive(state(1))
        #expect(s.select(1) == false)
        #expect(s.select(3) == true)
        #expect(s.shown == 3)
        // The service's reply for the tab just picked isn't a second move.
        #expect(s.receive(state(3)) == false)
    }

    @Test func framesFromOtherTabsAreDropped() {
        var s = BrowserTabSelection()
        #expect(s.accepts(frameTabId: 7)) // shown tab not known yet
        _ = s.receive(state(2))
        #expect(s.accepts(frameTabId: 2))
        #expect(!s.accepts(frameTabId: 1))
        #expect(s.accepts(frameTabId: nil))
        _ = s.select(1)
        #expect(!s.accepts(frameTabId: 2)) // still in flight from the old tab
        #expect(s.accepts(frameTabId: 1))
    }

    @Test func theStripShowsEveryTabEvenALoneOne() {
        #expect(BrowserTabSelection.strip(nil).isEmpty)
        #expect(BrowserTabSelection.strip(state(1)).isEmpty)
        #expect(BrowserTabSelection.strip(state(1, tabs: [tab(1)])).map(\.id) == [1])
        #expect(BrowserTabSelection.strip(state(1, tabs: [tab(1), tab(2)])).map(\.id) == [1, 2])
        #expect(!BrowserTabSelection.supportsTabs(nil))
        #expect(!BrowserTabSelection.supportsTabs(state(nil)))
        #expect(BrowserTabSelection.supportsTabs(state(1, tabs: [tab(1)])))
    }

    @Test func labels() {
        #expect(BrowserTabSelection.label(tab(1, "https://example.com/a", "  Example  ")) == "Example")
        #expect(BrowserTabSelection.label(tab(1, "https://docs.example.com:8443/a?b", " ")) == "docs.example.com")
        #expect(BrowserTabSelection.label(tab(1, "about:blank")) == "New Tab")
        #expect(BrowserTabSelection.label(tab(1, "about:blank", "about:blank")) == "New Tab")
        #expect(BrowserTabSelection.label(tab(1, "")) == "New Tab")
        #expect(BrowserTabSelection.label(tab(1, "data:text/html,hi")) == "data:text/html,hi")
    }
}
