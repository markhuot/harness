import Foundation
import Testing
@testable import HarnessKit

private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(text.utf8))
}

/// Encodes `value` and checks it is exactly `text` as JSON (keys absent stay absent).
private func encodes(_ value: some Encodable, _ text: String) throws -> Bool {
    try jsonEqual(JSONEncoder().encode(value), Data(text.utf8))
}

/// Browser tabs on the wire (shared/src/protocol.ts): tab ids on state, frames, subscribe and input,
/// and the newTab / closeTab inputs. Everything new is optional, so an older service's messages
/// decode as before and nothing it doesn't know is sent to it.
@Suite("Browser tabs protocol")
struct BrowserTabsProtocolTests {
    @Test func newTabAndCloseTabAreKnownInputs() throws {
        #expect(try decode(BrowserInput.self, #"{"type":"newTab","url":"http://localhost:3000/"}"#) == .newTab(url: "http://localhost:3000/"))
        #expect(try decode(BrowserInput.self, #"{"type":"newTab"}"#) == .newTab(url: nil))
        #expect(try decode(BrowserInput.self, #"{"type":"closeTab"}"#) == .closeTab)
        #expect(try encodes(BrowserInput.newTab(url: "https://example.com"), #"{"type":"newTab","url":"https://example.com"}"#))
        // No url: the key is left out, not sent as null.
        #expect(try encodes(BrowserInput.newTab(url: nil), #"{"type":"newTab"}"#))
        #expect(try encodes(BrowserInput.closeTab, #"{"type":"closeTab"}"#))
        #expect(BrowserInput.newTab(url: nil).type == "newTab")
        #expect(BrowserInput.closeTab.type == "closeTab")
    }

    @Test func stateWithoutTabsIsAnOlderService() throws {
        let raw = #"{"sessionId":"ses_31","url":"http://localhost:3000/login","title":"Log in","loading":false}"#
        let s = try decode(BrowserState.self, raw)
        #expect(s.tabId == nil)
        #expect(s.tabs == nil)
        #expect(try encodes(s, raw))
    }

    @Test func stateWithTabs() throws {
        let raw = #"""
        {"sessionId":"ses_31","tabId":3,"url":"https://example.com/","title":"Example","loading":true,
         "tabs":[{"id":1,"url":"about:blank","title":"","loading":false},{"id":3,"url":"https://example.com/","title":"Example","loading":true}]}
        """#
        let s = try decode(BrowserState.self, raw)
        #expect(s.tabId == 3)
        #expect(s.tabs == [
            BrowserTab(id: 1, url: "about:blank", title: "", loading: false),
            BrowserTab(id: 3, url: "https://example.com/", title: "Example", loading: true),
        ])
        #expect(try encodes(s, raw))
    }

    @Test func frameTabIdIsOptional() throws {
        let old = #"{"kind":"browser.frame","sessionId":"ses_31","data":"AAAA","width":1280,"height":800}"#
        #expect(try decode(HarnessEvent.self, old) == .browserFrame(sessionId: "ses_31", tabId: nil, data: "AAAA", width: 1280, height: 800))
        #expect(try encodes(try decode(HarnessEvent.self, old), old))

        let new = #"{"kind":"browser.frame","sessionId":"ses_31","tabId":2,"data":"AAAA","width":1280,"height":800}"#
        #expect(try decode(HarnessEvent.self, new) == .browserFrame(sessionId: "ses_31", tabId: 2, data: "AAAA", width: 1280, height: 800))
        #expect(try encodes(try decode(HarnessEvent.self, new), new))
    }

    @Test func subscribeAndInputCarryTheTab() throws {
        let sub = #"{"type":"browser.subscribe","sessionId":"ses_31","tabId":4}"#
        #expect(try decode(ClientMessage.self, sub) == .browserSubscribe(sessionId: "ses_31", tabId: 4))
        #expect(try encodes(ClientMessage.browserSubscribe(sessionId: "ses_31", tabId: 4), sub))
        #expect(try encodes(ClientMessage.browserSubscribe(sessionId: "ses_31"), #"{"type":"browser.subscribe","sessionId":"ses_31"}"#))

        let input = #"{"type":"browser.input","sessionId":"ses_31","tabId":4,"input":{"type":"closeTab"}}"#
        #expect(try decode(ClientMessage.self, input) == .browserInput(sessionId: "ses_31", tabId: 4, input: .closeTab))
        #expect(try encodes(ClientMessage.browserInput(sessionId: "ses_31", tabId: 4, input: .closeTab), input))
        #expect(try decode(ClientMessage.self, #"{"type":"browser.input","sessionId":"ses_31","input":{"type":"back"}}"#)
            == .browserInput(sessionId: "ses_31", tabId: nil, input: .back))
    }

    @Test func navigateBodyLeavesOutAMissingTab() throws {
        #expect(try encodes(NavigateBody(url: "https://example.com"), #"{"url":"https://example.com"}"#))
        #expect(try encodes(NavigateBody(url: "https://example.com", tabId: 2), #"{"url":"https://example.com","tabId":2}"#))
    }
}
