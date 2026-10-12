import Testing
@testable import HarnessKit

struct TicketViewMemoryTests {
    @Test func aBlurWithTheDismissalKeepsTheFocus() {
        let m = TicketViewMemory()
        m.focusChanged(true, key: "A-1", at: 1)
        m.focusChanged(false, key: "A-1", at: 5)
        m.composerDisappeared(key: "A-1", at: 5.2)
        #expect(m.wasFocused(key: "A-1"))
        // And the other way round: it left the screen, then the blur came.
        let n = TicketViewMemory()
        n.focusChanged(true, key: "A-1", at: 1)
        n.composerDisappeared(key: "A-1", at: 5)
        n.focusChanged(false, key: "A-1", at: 5.3)
        #expect(n.wasFocused(key: "A-1"))
    }

    @Test func aBlurWhileTheComposerStaysOnScreenClearsIt() {
        let m = TicketViewMemory()
        m.focusChanged(true, key: "A-1", at: 1)
        m.focusChanged(false, key: "A-1", at: 5)
        // It left a minute later, long after the person tapped away.
        m.composerDisappeared(key: "A-1", at: 65)
        #expect(!m.wasFocused(key: "A-1"))
        #expect(!m.wasFocused(key: "A-1"))
    }

    @Test func aBlurBeforeAnyDisappearanceClearsIt() {
        let m = TicketViewMemory()
        m.focusChanged(true, key: "A-1", at: 1)
        m.focusChanged(false, key: "A-1", at: 2)
        #expect(!m.wasFocused(key: "A-1"))
    }

    @Test func scrollAndFocusAreKeptPerTicketUntilForgotten() {
        let m = TicketViewMemory()
        m.setOffset(320, for: "A-1/spec")
        m.setOffset(40, for: "B-1/spec")
        m.focusChanged(true, key: "A-1", at: 1)
        #expect(m.offset(for: "A-1/spec") == 320 && m.offset(for: "B-1/spec") == 40)
        #expect(m.wasFocused(key: "A-1") && !m.wasFocused(key: "B-1"))
        m.forget(key: "A-1")
        #expect(m.offset(for: "A-1/spec") == nil && m.offset(for: "B-1/spec") == 40 && !m.wasFocused(key: "A-1"))
    }
}
