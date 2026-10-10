import Foundation
import Testing
@testable import HarnessKit

@MainActor struct SheetFlickTests {
    typealias Outcome = SheetFlick.Outcome

    // MARK: The rule

    @Test func fastDismissesEvenOverAShortDistance() {
        #expect(SheetFlick.outcome(velocity: 601, distance: 20, travel: 800) == .dismiss)
        #expect(SheetFlick.outcome(velocity: 600, distance: 20, travel: 800) == .restore)
        #expect(SheetFlick.outcome(velocity: 599, distance: 20, travel: 800) == .restore)
    }

    @Test func slowDocksFromSixtyPercentOfTheTravel() {
        #expect(SheetFlick.outcome(velocity: 200, distance: 479, travel: 800) == .restore)
        #expect(SheetFlick.outcome(velocity: 200, distance: 480, travel: 800) == .dock)
        #expect(SheetFlick.outcome(velocity: 200, distance: 800, travel: 800) == .dock)
    }

    @Test func movingBackTowardOpenNeverDismissesOrDocks() {
        #expect(SheetFlick.outcome(velocity: -3000, distance: 20, travel: 800) == .restore)
        #expect(SheetFlick.outcome(velocity: -3000, distance: -50, travel: 800) == .restore)
        #expect(SheetFlick.outcome(velocity: 0, distance: -500, travel: 800) == .restore)
    }

    @Test func noDistanceOrNoTravelRestores() {
        #expect(SheetFlick.outcome(velocity: 0, distance: 0, travel: 800) == .restore)
        #expect(SheetFlick.outcome(velocity: 0, distance: 0, travel: 0) == .restore)
        #expect(SheetFlick.outcome(velocity: 0, distance: 50, travel: 0) == .restore)
    }

    // MARK: Release first, settle second

    final class Answer { var outcomes: [Outcome] = [] }
    func settle(_ f: SheetFlick) -> Answer {
        let a = Answer()
        f.settled { a.outcomes.append($0) }
        return a
    }
    @discardableResult
    func release(_ f: SheetFlick, velocity: Double, distance: Double = 100) -> [Outcome] {
        var applied: [Outcome] = []
        f.ended(velocity: velocity, distance: distance, travel: 800) { applied.append($0) }
        return applied
    }

    @Test func theReleaseIsAppliedTheMomentTheFingerLifts() {
        let f = SheetFlick()
        f.began()
        #expect(release(f, velocity: 1500) == [.dismiss])
        #expect(!f.isDragging)
    }

    @Test func aSettleAfterAReleaseOnlyConfirmsIt() {
        // However long the system took to report, a fast flick is a dismiss: nothing is timed.
        let f = SheetFlick()
        f.began()
        release(f, velocity: 1500)
        #expect(settle(f).outcomes == [.dismiss])

        let g = SheetFlick()
        g.began()
        release(g, velocity: 100, distance: 300)
        #expect(settle(g).outcomes == [.restore])
    }

    @Test func aSettleBeforeTheReleaseWaitsForItAndNeverDocksOnItsOwn() {
        let f = SheetFlick()
        f.began()
        let a = settle(f)
        #expect(a.outcomes.isEmpty)
        #expect(release(f, velocity: 1500) == [.dismiss])
        #expect(a.outcomes == [.dismiss])
    }

    @Test func aSlowReleaseDecidesByDistanceInEitherOrder() {
        let f = SheetFlick()
        f.began()
        release(f, velocity: 200, distance: 700)
        #expect(settle(f).outcomes == [.dock])

        let g = SheetFlick()
        g.began()
        let a = settle(g)
        release(g, velocity: 200, distance: 100)
        #expect(a.outcomes == [.restore])
    }

    @Test func aSettleIsConfirmedOnce() {
        let f = SheetFlick()
        f.began()
        release(f, velocity: 1500)
        #expect(settle(f).outcomes == [.dismiss])
        // With no drag behind it, the next settle is a programmatic one.
        #expect(settle(f).outcomes == [.dock])
    }

    @Test func aNewDragForgetsTheLastRelease() {
        let f = SheetFlick()
        f.began()
        release(f, velocity: 3000)
        f.began()
        f.cancelled()
        #expect(settle(f).outcomes == [.dock])
    }

    @Test func aCancelledDragLetsAWaitingSettleDock() {
        let f = SheetFlick()
        f.began()
        let a = settle(f)
        f.cancelled()
        #expect(a.outcomes == [.dock])
    }

    @Test func aSettleWithNoDragDocks() {
        #expect(settle(SheetFlick()).outcomes == [.dock])
    }

    @Test func draggingIsTrackedForMeasurements() {
        let f = SheetFlick()
        #expect(!f.isDragging)
        f.began()
        #expect(f.isDragging)
        release(f, velocity: 0)
        #expect(!f.isDragging)
    }
}
