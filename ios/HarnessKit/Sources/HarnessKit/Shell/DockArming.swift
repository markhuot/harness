import Foundation

/// When a drag on an open ticket arms docking, on the iPhone's sheet (dragged down) and the iPad's
/// side panel (dragged right): one rule for both, so they can't drift apart. Axis-agnostic: it is
/// fed the finger's progress toward the way out as a fraction of the screen along that axis (0 at
/// the near edge, 1 at the far one) and how far the sheet or panel itself has left its resting place.
///
/// Docking is a deliberate hold, never momentum: the finger has to stay in the last 40% of the screen
/// for `dwell` while the sheet is displaced by more than `minDisplacement`. The displacement is how
/// a drag that moves the sheet is told from one that scrolls its content with a thumb resting low.
/// Nothing here reads velocity.
///
/// A release while armed latches an intent with its time. The system's dismissal (or the panel's
/// slide) reads it once, with `takeIntent`, so a programmatic dismissal later can never dock, and an
/// intent nobody picked up goes stale after `intentLifetime`.
public struct DockArming: Equatable, Sendable {
    /// The finger counts as in the zone from this fraction of the screen on: the last 40%.
    public static let zoneStart = 0.6
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

/// What letting go of the iPad's side panel does. The phone's sheet has the system for this; the
/// panel is a custom view and decides itself, as little as possible: a drag closes it when it moved
/// at least `minDistance` and the finger was heading for past half the panel's width, else it
/// springs back. Never docks (that's the hold, DockArming).
public enum PanelRelease {
    /// The least a drag moves to close. The panel, unlike the system sheet, has nothing else to stop
    /// a tiny flick sending it away; the attachment viewer's flick distance is the same.
    public static let minDistance = 40.0
    /// How far across the panel's width the drag's projected end has to reach.
    public static let halfway = 0.5

    /// `translation` is how far the finger moved toward the way out, `predictedEnd` where its
    /// momentum would carry that translation (DragGesture's `predictedEndTranslation`).
    public static func closes(translation: Double, predictedEnd: Double, width: Double) -> Bool {
        translation >= minDistance && predictedEnd >= width * halfway
    }
}
