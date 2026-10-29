import Foundation

/// When a drag on an open ticket sheet arms docking. It is fed the finger's progress down the screen
/// (0 at the top edge, 1 at the bottom) and how far the sheet itself has left the detent it rested
/// at when the finger came down.
///
/// Docking is a deliberate hold, never momentum: the finger has to stay in the bottom fifth of the
/// screen for `dwell` while the sheet is displaced by more than `minDisplacement`. The zone starts
/// below where the quarter-open sheet's top edge rests (`TicketSheetPlacement.peekFraction`), so a
/// drag that settles at that detent never arms: docking is pulling the sheet below its smallest stop
/// and holding. The displacement is how a drag that moves the sheet is told from one that scrolls its
/// content with a thumb resting low. Nothing here reads velocity.
///
/// A release while armed latches an intent with its time. The system's dismissal reads it once, with
/// `takeIntent`, so a programmatic dismissal later can never dock, and an intent nobody picked up goes
/// stale after `intentLifetime`.
public struct DockArming: Equatable, Sendable {
    /// The finger counts as in the zone from this fraction of the screen on: the bottom fifth, below
    /// the quarter-open sheet's top edge.
    public static let zoneStart = 0.8
    /// How long the finger holds in the zone before it arms (s).
    public static let dwell: TimeInterval = 0.5
    /// How far the sheet has to be from rest (pt) for the hold to count.
    public static let minDisplacement = 80.0
    /// How long a latched release stays valid (s).
    public static let intentLifetime: TimeInterval = 1.5

    /// The ghost dock card is showing and a release will dock.
    public private(set) var armed = false
    private var enteredAt: TimeInterval?
    private var latchedAt: TimeInterval?

    public init() {}

    /// The finger or the sheet moved (or `now` ticked): returns whether it's armed. `now` is any
    /// monotonic clock, in seconds.
    @discardableResult
    public mutating func update(progress: Double, displacement: Double, now: TimeInterval) -> Bool {
        guard progress >= Self.zoneStart, displacement > Self.minDisplacement else {
            enteredAt = nil
            armed = false
            return false
        }
        let since = enteredAt ?? now
        enteredAt = since
        armed = now - since >= Self.dwell
        return armed
    }

    /// When the hold would arm, if the finger stays put; nil outside the zone or once armed. For
    /// a timer, since a still finger sends no events.
    public func armsAt() -> TimeInterval? {
        guard !armed, let enteredAt else { return nil }
        return enteredAt + Self.dwell
    }

    /// A new finger: forgets any earlier hold and latched release.
    public mutating func touchDown() { cancel() }

    /// The finger lifted: an armed hold latches a dock intent.
    public mutating func release(now: TimeInterval) {
        if armed { latchedAt = now }
        armed = false
        enteredAt = nil
    }

    /// The touch was cancelled: nothing arms, nothing latches.
    public mutating func cancel() {
        armed = false
        enteredAt = nil
        latchedAt = nil
    }

    /// Whether the dismissal now happening is the armed release, read and cleared in one step.
    public mutating func takeIntent(now: TimeInterval) -> Bool {
        defer { latchedAt = nil }
        guard let latchedAt else { return false }
        return now - latchedAt <= Self.intentLifetime
    }
}
