import Testing
@testable import HarnessKit

struct DockArmingTests {
    private func take(_ a: inout DockArming, _ now: Double) -> Bool { a.takeIntent(now: now) }
    private func step(_ a: inout DockArming, _ p: Double, _ d: Double, _ now: Double) -> Bool { a.update(progress: p, displacement: d, now: now) }

    private func holding(_ a: inout DockArming, at progress: Double = 0.8, displacement: Double = 200, from t: Double = 0, for s: Double) -> Bool {
        a.update(progress: progress, displacement: displacement, now: t)
        return a.update(progress: progress, displacement: displacement, now: t + s)
    }

    @Test func armsAfterTheDwellInTheZone() {
        var a = DockArming()
        #expect(!holding(&a, for: 0.49))
        var b = DockArming()
        #expect(holding(&b, for: 0.5))
    }

    @Test func zoneStartsAtSixtyPercent() {
        var a = DockArming()
        #expect(!holding(&a, at: 0.599, for: 2))
        var b = DockArming()
        #expect(holding(&b, at: 0.6, for: 2))
    }

    @Test func aSheetBarelyDisplacedNeverArms() {
        // A thumb resting low while scrolling content: the sheet hasn't moved.
        var a = DockArming()
        #expect(!holding(&a, displacement: 80, for: 5))
        var b = DockArming()
        #expect(holding(&b, displacement: 81, for: 5))
    }

    @Test func leavingTheZoneDisarmsAndRestartsTheDwell() {
        var a = DockArming()
        #expect(holding(&a, for: 1))
        #expect(!step(&a, 0.3, 200, 1.1))
        // Back in: the 0.5 s starts again, not from the first entry.
        #expect(!step(&a, 0.9, 200, 1.2))
        #expect(!step(&a, 0.9, 200, 1.6))
        #expect(step(&a, 0.9, 200, 1.7))
    }

    @Test func theSheetReturningTowardRestDisarms() {
        var a = DockArming()
        #expect(holding(&a, for: 1))
        #expect(!step(&a, 0.9, 40, 1.1))
    }

    @Test func armsAtReportsWhenAStillFingerArms() {
        var a = DockArming()
        #expect(a.armsAt() == nil)
        a.update(progress: 0.9, displacement: 200, now: 10)
        #expect(a.armsAt() == 10.5)
        a.update(progress: 0.9, displacement: 200, now: 10.5)
        #expect(a.armsAt() == nil)
    }

    @Test func anArmedReleaseLatchesOneIntentThatIsReadOnce() {
        var a = DockArming()
        _ = holding(&a, for: 1)
        a.release(now: 2)
        #expect(!a.armed)
        #expect(take(&a, 2.1))
        // Read and cleared: a programmatic dismissal right after can't dock.
        #expect(!take(&a, 2.2))
    }

    @Test func anUnarmedReleaseLatchesNothing() {
        var a = DockArming()
        _ = holding(&a, for: 0.3)
        a.release(now: 1)
        #expect(!take(&a, 1))
    }

    @Test func aStaleIntentIsIgnored() {
        var a = DockArming()
        _ = holding(&a, for: 1)
        a.release(now: 2)
        #expect(!take(&a, 3.6))
        var b = DockArming()
        _ = holding(&b, for: 1)
        b.release(now: 2)
        #expect(take(&b, 3.5))
    }

    @Test func aCancelOrANewTouchClearsTheIntent() {
        var a = DockArming()
        _ = holding(&a, for: 1)
        a.release(now: 2)
        a.cancel()
        #expect(!take(&a, 2))
        var b = DockArming()
        _ = holding(&b, for: 1)
        b.release(now: 2)
        b.touchDown()
        #expect(!take(&b, 2))
    }
}

struct PanelReleaseTests {
    @Test func shortFlicksSpringBackWhateverTheMomentum() {
        #expect(!PanelRelease.closes(translation: 5, predictedEnd: 5000, width: 800))
        #expect(!PanelRelease.closes(translation: 39, predictedEnd: 5000, width: 800))
    }

    @Test func fortyPointsWithAProjectionPastHalfCloses() {
        #expect(PanelRelease.closes(translation: 40, predictedEnd: 400, width: 800))
        #expect(!PanelRelease.closes(translation: 40, predictedEnd: 399, width: 800))
    }

    @Test func aLongSlowDragShortOfHalfwaySpringsBack() {
        #expect(!PanelRelease.closes(translation: 300, predictedEnd: 320, width: 800))
    }

    @Test func draggingBackTowardOpenNeverCloses() {
        #expect(!PanelRelease.closes(translation: -100, predictedEnd: 900, width: 800))
    }
}
