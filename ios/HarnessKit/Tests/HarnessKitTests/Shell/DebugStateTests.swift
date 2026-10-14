import Foundation
import Testing
@testable import HarnessKit

/// The probe's JSON shape ios/Tools/sim-check.ts parses, and the settle rule it waits on.
@MainActor
@Suite("DebugState")
struct DebugStateTests {
    private func state(busy: [String] = [], editor: DebugState.EditorState? = nil) -> DebugState {
        DebugState(
            busy: busy,
            router: .init(selectedTab: "board", path: [], sheet: nil, cover: nil, ticketSheet: "gone", dock: []),
            editor: editor)
    }

    @Test func routerStateNamesTheTabStackAndSheet() {
        let r = Router()
        r.open(.tab(.inbox))
        r.open(.push(.triage(sessionId: "s1")))
        r.open(.sheet(.projects))
        let s = DebugState.router(r)
        #expect(s.selectedTab == "inbox")
        #expect(s.path == ["triage:s1"])
        #expect(s.sheet == "projects")
        #expect(s.ticketSheet == "gone" && s.dock.isEmpty)
    }

    @Test func aTicketOpensAPresentedSheetThatDocks() {
        let r = Router()
        r.open(.push(.ticket(key: "A-1", tab: "spec")))
        #expect(DebugState.router(r).ticketSheet == "presented")
        #expect(DebugState.router(r).dock.map(\.title) == ["A-1"])
        r.open(.tab(.board))
        let docked = DebugState.router(r)
        #expect(docked.ticketSheet == "docked")
        #expect(docked.dock.first?.kind == "ticket")
    }

    @Test func routesDescribeAsKindAndDetail() {
        #expect(DebugState.describe(.ticket(key: "A-1", tab: "spec")) == "ticket:A-1:spec")
        #expect(DebugState.describe(.ticket(key: "A-1", tab: nil)) == "ticket:A-1")
        #expect(DebugState.describe(.file(FileRouteParams(path: "a/b.ts"))) == "file:a/b.ts")
        #expect(DebugState.describe(.prompts) == "prompts")
        #expect(DebugState.describe(SheetRoute.newSession(projectId: "p", key: nil)) == "newSession:p")
    }

    @Test func jsonRoundTripsAndKeepsKeysStable() throws {
        let editor = DebugState.EditorState(
            markedLines: ["let x = 1"], selection: .init(anchor: 2, head: 5), dirty: true, scrollY: 40, lineCount: 9, colors: 4)
        var original = state(editor: editor)
        original.dockMounts = 1
        let data = try original.json()
        #expect(try DebugState.decode(data) == original)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(object.keys) == ["version", "seq", "settled", "quietMs", "busy", "dockMounts", "router", "editor"])
        let e = try #require(object["editor"] as? [String: Any])
        #expect(Set(e.keys) == ["markedLines", "selection", "dirty", "scrollY", "lineCount", "colors"])
        // Sorted keys: equal states are equal bytes.
        var again = state(editor: editor)
        again.dockMounts = 1
        #expect(try original.json() == again.json())
    }

    @Test func noEditorEncodesWithoutTheKey() throws {
        let object = try #require(try JSONSerialization.jsonObject(with: state().json()) as? [String: Any])
        #expect(object["editor"] == nil)
    }

    @Test func settlesOnceStateHasBeenQuietForTheWindow() {
        var settle = DebugSettle()
        #expect(settle.stamp(state(), now: 10).settled == false)
        #expect(settle.stamp(state(), now: 10.1).settled == false)
        let at = settle.stamp(state(), now: 10.3)
        #expect(at.quietMs == 300 && at.settled)
    }

    @Test func aChangeRestartsTheQuietWindow() {
        var settle = DebugSettle()
        _ = settle.stamp(state(), now: 0)
        #expect(settle.stamp(state(), now: 1).settled)
        var moved = state()
        moved.router.selectedTab = "inbox"
        let after = settle.stamp(moved, now: 1.05)
        #expect(after.quietMs == 0 && !after.settled)
    }

    @Test func busyBlocksSettledHoweverQuiet() {
        var settle = DebugSettle()
        _ = settle.stamp(state(busy: ["editor"]), now: 0)
        let s = settle.stamp(state(busy: ["editor"]), now: 5)
        #expect(s.quietMs == 5000 && !s.settled)
        #expect(settle.stamp(state(), now: 5.1).settled == false) // busy cleared: a change, so quiet restarts
    }

    @Test func seqCountsWritesAndNeverCountsAsAChange() {
        var settle = DebugSettle()
        _ = settle.stamp(state(), now: 0)
        let second = settle.stamp(state(), now: 1)
        #expect(second.seq == 2 && second.quietMs == 1000)
    }
}
