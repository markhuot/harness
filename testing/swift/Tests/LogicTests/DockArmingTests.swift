import Testing
import HarnessKit

/// The hold-to-dock rule on an iPhone 17 Pro's 874pt screen, whose full-height sheet rests at y 62.
@Suite struct DockArmingTests {
    static let screen = 874.0
    static let fullTop = 62.0
    /// Where the quarter-open sheet's top edge rests.
    static let peekTop = screen - TicketSheetPlacement.peekFraction * (screen - fullTop)

    /// A finger on the grabber, a little below the sheet's top edge, as a fraction of the screen.
    static func progress(sheetTop: Double) -> Double { (sheetTop + 12) / screen }

    @Test func aDragThatSettlesAtTheQuarterStopNeverArms() {
        var arming = DockArming()
        let p = Self.progress(sheetTop: Self.peekTop)
        arming.update(progress: p, displacement: Self.peekTop - Self.fullTop, now: 0)
        #expect(arming.update(progress: p, displacement: Self.peekTop - Self.fullTop, now: 5) == false)
        #expect(arming.armsAt() == nil)
    }

    @Test func pulledBelowTheQuarterStopAndHeldItArmsAfterTheDwell() {
        var arming = DockArming()
        let top = Self.peekTop + 80
        #expect(arming.update(progress: Self.progress(sheetTop: top), displacement: top - Self.fullTop, now: 10) == false)
        #expect(arming.armsAt() == 10 + DockArming.dwell)
        #expect(arming.update(progress: Self.progress(sheetTop: top), displacement: top - Self.fullTop, now: 10.49) == false)
        #expect(arming.update(progress: Self.progress(sheetTop: top), displacement: top - Self.fullTop, now: 10.5) == true)
    }

    @Test func movingInsideTheZoneKeepsTheDwellRunning() {
        var arming = DockArming()
        arming.update(progress: 0.82, displacement: 600, now: 0)
        arming.update(progress: 0.88, displacement: 650, now: 0.3)
        #expect(arming.update(progress: 0.93, displacement: 700, now: 0.5) == true)
    }

    @Test func leavingTheZoneStartsTheDwellOver() {
        var arming = DockArming()
        arming.update(progress: 0.85, displacement: 600, now: 0)
        arming.update(progress: 0.7, displacement: 500, now: 0.3)
        arming.update(progress: 0.85, displacement: 600, now: 0.4)
        #expect(arming.update(progress: 0.85, displacement: 600, now: 0.8) == false)
        #expect(arming.update(progress: 0.85, displacement: 600, now: 0.9) == true)
    }

    /// Displacement is measured from the detent the sheet rested at when the finger came down, so a
    /// thumb held on the quarter-open sheet's composer hasn't moved it.
    @Test func aFingerHeldLowOnARestingSheetNeverArms() {
        var arming = DockArming()
        arming.update(progress: 0.95, displacement: 0, now: 0)
        #expect(arming.update(progress: 0.95, displacement: DockArming.minDisplacement, now: 2) == false)
    }

    @Test func anArmedReleaseLatchesOneIntent() {
        var arming = DockArming()
        arming.update(progress: 0.9, displacement: 600, now: 0)
        arming.update(progress: 0.9, displacement: 600, now: 0.6)
        arming.release(now: 0.7)
        #expect(arming.armed == false)
        #expect(arming.takeIntent(now: 0.8) == true)
        #expect(arming.takeIntent(now: 0.9) == false)
    }

    @Test func anUnarmedReleaseOrAStaleIntentDoesNotDock() {
        var early = DockArming()
        early.update(progress: 0.9, displacement: 600, now: 0)
        early.release(now: 0.3)
        #expect(early.takeIntent(now: 0.4) == false)

        var stale = DockArming()
        stale.update(progress: 0.9, displacement: 600, now: 0)
        stale.update(progress: 0.9, displacement: 600, now: 0.6)
        stale.release(now: 1)
        #expect(stale.takeIntent(now: 1 + DockArming.intentLifetime + 0.01) == false)
    }
}
