import Testing
@testable import HarnessKit

/// A ticket docked and reopened lands back at its scroll position (the walkthrough's "docked with the
/// keyboard up reopens from its card at its scroll position" used to scroll, dock and reopen to see it).
@Suite("ScrollRestore")
struct ScrollRestoreTests {
    @Test func theFirstReadingScrollsToTheSavedOffsetAndKeepsAskingUntilItIsThere() {
        var r = ScrollRestore()
        // The screen comes up at the top with 400 saved: ask for it, and don't write 0 over it.
        #expect(r.step(offset: 0, saved: 400, now: 10) == .scrollTo(400))
        #expect(r.pending?.y == 400)
        // Content still loading: the view hasn't moved, so ask again (the saved offset isn't re-read).
        #expect(r.step(offset: 0, saved: nil, now: 10.5) == .scrollTo(400))
        #expect(r.step(offset: 120, saved: nil, now: 11) == .scrollTo(400))
        // Arrived: the restore ends without recording, then readings are recorded.
        #expect(r.step(offset: 400, saved: nil, now: 11.2) == .none)
        #expect(r.pending == nil)
        #expect(r.step(offset: 430, saved: nil, now: 12) == .record(430))
    }

    @Test func within2PointsCountsAsThere() {
        var r = ScrollRestore()
        _ = r.step(offset: 0, saved: 400, now: 0)
        #expect(r.step(offset: 398.5, saved: nil, now: 0.1) == .none)
        var s = ScrollRestore()
        _ = s.step(offset: 0, saved: 400, now: 0)
        #expect(s.step(offset: 398, saved: nil, now: 0.1) == .scrollTo(400))
    }

    @Test func itGivesUpAfterTheWindow() {
        var r = ScrollRestore()
        #expect(r.step(offset: 0, saved: 400, now: 10) == .scrollTo(400))
        // Exactly at the deadline it still tries; just past it, it stops and the page is where it is.
        #expect(r.step(offset: 0, saved: nil, now: 10 + ScrollRestore.window) == .scrollTo(400))
        #expect(r.step(offset: 0, saved: nil, now: 10 + ScrollRestore.window + 0.01) == .none)
        #expect(r.step(offset: 0, saved: nil, now: 12) == .record(0))
    }

    @Test func thePersonScrollingCancelsTheRestore() {
        var r = ScrollRestore()
        _ = r.step(offset: 0, saved: 400, now: 10)
        r.interrupt()
        #expect(r.pending == nil)
        #expect(r.step(offset: 37, saved: 400, now: 10.1) == .record(37))
    }

    @Test func aTouchBeforeTheFirstReadingMeansNothingIsRestoredLater() {
        var r = ScrollRestore()
        r.interrupt()
        // The saved offset is never consulted: the person already has the scroll view.
        #expect(r.step(offset: 12, saved: 400, now: 0) == .record(12))
    }

    @Test func nothingSavedOrNearTheTopRecordsFromTheStart() {
        var a = ScrollRestore()
        #expect(a.step(offset: 0, saved: nil, now: 0) == .record(0))
        var b = ScrollRestore()
        #expect(b.step(offset: 0, saved: 2, now: 0) == .record(0))
        var c = ScrollRestore()
        #expect(c.step(offset: 0, saved: 2.5, now: 0) == .scrollTo(2.5))
        var d = ScrollRestore()
        #expect(d.step(offset: 0, saved: -50, now: 0) == .scrollTo(-50)) // an inset above the top counts
    }

    @Test func theSavedOffsetIsReadOnceNotOnEveryReading() {
        var r = ScrollRestore()
        var reads = 0
        func saved() -> Double? { reads += 1; return nil }
        for i in 0..<5 { _ = r.step(offset: Double(i), saved: saved(), now: 0) }
        #expect(reads == 1)
    }
}
