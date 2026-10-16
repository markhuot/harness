import Foundation
import Testing
@testable import HarnessKit

@Suite("Terminal bridge")
struct TerminalBridgeTests {
    @Test func eventsDecodeAndMalformedOnesAreDropped() {
        #expect(TerminalEvent.decode(json: #"{"type":"ready"}"#) == .ready)
        #expect(TerminalEvent.decode(json: #"{"type":"input","data":"ls\r"}"#) == .input("ls\r"))
        #expect(TerminalEvent.decode(json: #"{"type":"viewport","cols":62,"rows":18}"#) == .viewport(cols: 62, rows: 18))
        #expect(TerminalEvent.decode(json: #"{"type":"title","title":"vim"}"#) == .title("vim"))
        #expect(TerminalEvent.decode(json: #"{"type":"exit","exitCode":2}"#) == .exit(2))
        #expect(TerminalEvent.decode(json: #"{"type":"exit","exitCode":null}"#) == .exit(nil))
        #expect(TerminalEvent.decode(json: #"{"type":"ctrl","on":true}"#) == .ctrl(true))
        #expect(TerminalEvent.decode(json: #"{"type":"resync"}"#) == .resync)
        // a viewport that isn't a usable size, an unknown type, junk and a non-string body
        #expect(TerminalEvent.decode(json: #"{"type":"viewport","cols":0,"rows":18}"#) == nil)
        #expect(TerminalEvent.decode(json: #"{"type":"viewport","cols":"a","rows":18}"#) == nil)
        #expect(TerminalEvent.decode(json: #"{"type":"fireworks"}"#) == nil)
        #expect(TerminalEvent.decode(json: "nope") == nil)
        #expect(TerminalEvent.decode(body: 5) == nil)
    }

    @Test func commandsBecomeOneScriptWithTheirJSON() throws {
        let script = TerminalCommand.message(.terminalOutput(id: "t-1", data: "a\u{2028}b\"", offset: 4)).script
        #expect(script.hasPrefix("window.harnessTerminal.receive("))
        #expect(script.hasSuffix("); true;"))
        #expect(!script.contains("\u{2028}"))
        #expect(script.contains(#""type":"terminal.output""#))
        #expect(TerminalCommand.paste("x").script.contains(#""text":"x""#))
        #expect(TerminalCommand.inset(291).script.contains(#""bottom":291"#))
        #expect(TerminalCommand.ctrl(true).script.contains(#""on":true"#))
    }

    @Test func accessoryKeysSendWhatAKeyboardWould() {
        #expect(TerminalKey.escape.sequence == "\u{1b}")
        #expect(TerminalKey.up.sequence == "\u{1b}[A")
        #expect(TerminalKey.left.sequence == "\u{1b}[D")
        #expect(Set(TerminalKey.allCases.map(\.sequence)).count == TerminalKey.allCases.count)
    }
}

@Suite("Terminal viewport rules")
struct TerminalViewportRulesTests {
    @Test func aSmallShrinkKeepsTheHeightButRealChangesDont() {
        #expect(TerminalViewportRules.ignoresShrink(from: 742, to: 708)) // the home indicator's inset
        #expect(TerminalViewportRules.ignoresShrink(from: 742, to: 622)) // an accessory bar's worth, at the limit
        #expect(!TerminalViewportRules.ignoresShrink(from: 742, to: 500)) // a different amount of room
        #expect(!TerminalViewportRules.ignoresShrink(from: 708, to: 742)) // growing always applies
        #expect(!TerminalViewportRules.ignoresShrink(from: 0, to: 600)) // the first size
        #expect(!TerminalViewportRules.ignoresShrink(from: 700, to: 700))
    }
}

@Suite("Terminal attach rules")
struct TerminalAttachRulesTests {
    @Test func attachesOnlyOnceVisibleAndMeasured() {
        var r = TerminalAttachRules()
        #expect(r.viewportChanged(cols: 60, rows: 20) == nil) // measured while hidden: nothing to attach yet
        #expect(r.visibilityChanged(true) == .attach(cols: 60, rows: 20))
        #expect(r.viewportChanged(cols: 62, rows: 20) == .resize(cols: 62, rows: 20))
    }

    @Test func backgroundingDetachesAndForegroundingAttachesAtTheLatestSize() {
        var r = TerminalAttachRules()
        _ = r.visibilityChanged(true)
        #expect(r.viewportChanged(cols: 60, rows: 20) == .attach(cols: 60, rows: 20))
        #expect(r.visibilityChanged(false) == .detach)
        #expect(r.visibilityChanged(false) == nil) // already detached
        #expect(r.viewportChanged(cols: 40, rows: 12) == nil) // a hidden sheet doesn't report its size
        #expect(r.visibilityChanged(true) == .attach(cols: 40, rows: 12))
    }

    @Test func aRebuiltSocketAttachesAgainAndAResyncDetachesFirst() {
        var r = TerminalAttachRules()
        _ = r.visibilityChanged(true)
        _ = r.viewportChanged(cols: 60, rows: 20)
        #expect(r.socketReset() == .attach(cols: 60, rows: 20))
        #expect(r.resync() == [.detach, .attach(cols: 60, rows: 20)])
        _ = r.visibilityChanged(false)
        #expect(r.resync().isEmpty)
        #expect(r.socketReset() == nil) // hidden: nothing to attach
    }

    @Test func theKeyboardNeverChangesTheReportedRowsBecauseOnlyViewportEventsDo() {
        // The page reports the web view's full size; the keyboard only moves the inset command.
        var r = TerminalAttachRules()
        _ = r.visibilityChanged(true)
        _ = r.viewportChanged(cols: 60, rows: 30)
        #expect(TerminalCommand.inset(300).script.contains("inset"))
        #expect(r.resync() == [.detach, .attach(cols: 60, rows: 30)])
    }

    @Test func keyBarSitsBelowTheWebViewUntilTheKeyboardLiftsIt() {
        // Keyboard down: its top is the bar's bottom edge (or lower, past the home indicator), nothing to lift.
        #expect(TerminalKeyBarRules.cover(webViewBottom: 700, barHeight: 48, keyboardTop: 852) == 0)
        #expect(TerminalKeyBarRules.cover(webViewBottom: 700, barHeight: 48, keyboardTop: 748) == 0)
        // Keyboard up: the bar rides up by the overlap, and the page pans clear of the same amount.
        #expect(TerminalKeyBarRules.cover(webViewBottom: 700, barHeight: 48, keyboardTop: 500) == 248)
    }
}
