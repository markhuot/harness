import Foundation
import Testing
@testable import HarnessKit

@Suite("TerminalList")
struct TerminalListTests {
    private func info(_ id: String, cwd: String = "/Users/me/Sites", title: String = "", process: String = "zsh", state: TerminalState = .running) -> TerminalInfo {
        TerminalInfo(id: id, cwd: cwd, title: title, process: process, state: state)
    }

    @Test func eventsAddReplaceAndRemove() {
        var list = TerminalList.apply([], .terminalCreated(terminal: info("a")))
        list = TerminalList.apply(list, .terminalCreated(terminal: info("b")))
        list = TerminalList.apply(list, .terminalUpdated(terminal: info("a", title: "vim")))
        #expect(list.map(\.id) == ["a", "b"])
        #expect(list.map(\.title) == ["vim", ""])
        // an update before its created (a reconnect gap) still lists it
        #expect(TerminalList.apply(list, .terminalUpdated(terminal: info("c"))).count == 3)
        #expect(TerminalList.apply(list, .terminalRemoved(id: "zzz")) == list)
        #expect(TerminalList.apply(list, .terminalRemoved(id: "a")).map(\.id) == ["b"])
        #expect(TerminalList.apply(list, .devicesChanged) == list)
    }

    @Test func rowsNameWhatItIsAndWhereItIs() {
        #expect(TerminalList.label(info("a", title: " npm run dev ", process: "node")) == "npm run dev")
        #expect(TerminalList.label(info("a")) == "zsh")
        #expect(TerminalList.label(info("a", process: "")) == "Terminal")
        #expect(TerminalList.subtitle(info("a", process: "node")) == "~/Sites · node")
        #expect(TerminalList.subtitle(info("a", cwd: "/tmp/x", state: .exited)) == "/tmp/x · ended")
        #expect(TerminalList.keywords(info("a", title: "vim", process: "vim")) == ["/Users/me/Sites", "vim", "vim"])
    }

    @Test func tildeOnlyShortensAHomeFolder() {
        #expect(TerminalList.tildePath("/Users/me") == "~")
        #expect(TerminalList.tildePath("/Users/me/Sites/harness") == "~/Sites/harness")
        #expect(TerminalList.tildePath("/home/me/x") == "~/x")
        #expect(TerminalList.tildePath("/var/Users/me") == "/var/Users/me")
        #expect(TerminalList.tildePath("/Users") == "/Users")
        #expect(TerminalList.tildePath("/") == "/")
    }
}
