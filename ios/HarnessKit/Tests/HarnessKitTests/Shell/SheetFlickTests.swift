import Foundation
import Testing
@testable import HarnessKit

@MainActor struct SheetFlickTests {
    let t0 = Date(timeIntervalSinceReferenceDate: 1000)

    /// Runs `settled` and returns what it decided, nil while it's still waiting.
    final class Answer { var outcome: SheetFlick.Outcome?; var calls = 0 }
    func settle(_ f: SheetFlick, at: Date) -> Answer {
        let a = Answer()
        f.settled(at: at) { a.outcome = $0; a.calls += 1 }
        return a
    }

    @Test func aFastReleaseSeenBeforeTheSettleDismissesAtOnce() {
        let f = SheetFlick()
        f.began()
        f.ended(velocity: 1500, at: t0)
        #expect(settle(f, at: t0).outcome == .dismiss)
    }

    @Test func aSettleBeforeTheReleaseWaitsForItWithoutDocking() {
        let f = SheetFlick()
        f.began()
        let a = settle(f, at: t0)
        #expect(a.outcome == nil)
        f.ended(velocity: 1500, at: t0)
        #expect(a.outcome == .dismiss)
        #expect(a.calls == 1)
    }

    @Test func aSlowReleaseDocksWhicheverComesFirst() {
        let f = SheetFlick()
        f.began()
        f.ended(velocity: 999, at: t0)
        #expect(settle(f, at: t0).outcome == .dock)

        let g = SheetFlick()
        g.began()
        let a = settle(g, at: t0)
        g.ended(velocity: 200, at: t0)
        #expect(a.outcome == .dock)
    }

    @Test func anUpwardFlingDocks() {
        let f = SheetFlick()
        f.began()
        f.ended(velocity: -3000, at: t0)
        #expect(settle(f, at: t0).outcome == .dock)
    }

    @Test func aReleaseOutsideTheWindowIsAnotherDrag() {
        let f = SheetFlick()
        f.began()
        f.ended(velocity: 3000, at: t0)
        #expect(settle(f, at: t0.addingTimeInterval(SheetFlick.window + 0.01)).outcome == .dock)
        #expect(settle(f, at: t0.addingTimeInterval(SheetFlick.window - 0.01)).outcome == .dismiss)
    }

    @Test func aNewDragForgetsTheLastRelease() {
        let f = SheetFlick()
        f.began()
        f.ended(velocity: 3000, at: t0)
        f.began()
        f.cancelled()
        #expect(settle(f, at: t0).outcome == .dock)
    }

    @Test func aCancelledDragDocksAWaitingSettle() {
        let f = SheetFlick()
        f.began()
        let a = settle(f, at: t0)
        f.cancelled()
        #expect(a.outcome == .dock)
    }

    @Test func noDragAtAllDocks() {
        #expect(settle(SheetFlick(), at: t0).outcome == .dock)
    }

    @Test func flushDocksAStuckSettleOnceAndThenTheReleaseIsIgnored() {
        let f = SheetFlick()
        f.began()
        let a = settle(f, at: t0)
        f.flush()
        #expect(a.outcome == .dock)
        f.ended(velocity: 3000, at: t0)
        f.flush()
        #expect(a.calls == 1)
    }

    @Test func draggingIsTrackedForMeasurements() {
        let f = SheetFlick()
        #expect(!f.isDragging)
        f.began()
        #expect(f.isDragging)
        f.ended(velocity: 0, at: t0)
        #expect(!f.isDragging)
    }
}
