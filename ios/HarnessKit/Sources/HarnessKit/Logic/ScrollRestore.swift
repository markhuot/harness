import Foundation

/// Getting a ticket tab back to where the person left it (TicketViewMemory) when its screen comes
/// up again, for instance from a docked card. The content may still be loading, so the restore keeps
/// asking for the saved offset on every scroll reading until the view reaches it, `window` seconds
/// pass, or the person scrolls themselves. Once it is done, readings are recorded as the new place.
public struct ScrollRestore: Equatable, Sendable {
    /// How long a restore keeps trying to reach the saved offset.
    public static let window = 1.5
    /// How close to the saved offset (pt) counts as there.
    public static let slop = 2.0

    /// What the view does with a reading.
    public enum Action: Equatable, Sendable {
        /// Scroll to this offset.
        case scrollTo(Double)
        /// Remember this offset as where the person is.
        case record(Double)
        /// Nothing: the restore just ended.
        case none
    }

    /// The first reading has been seen, so the saved offset has been looked at.
    public private(set) var started = false
    /// The offset being restored and the time it gives up at.
    public private(set) var pending: (y: Double, until: TimeInterval)?

    public init() {}

    public static func == (a: ScrollRestore, b: ScrollRestore) -> Bool {
        a.started == b.started && a.pending?.y == b.pending?.y && a.pending?.until == b.pending?.until
    }

    /// The next scroll reading, `y`, at time `now`. `saved` is read only for the first reading, before
    /// anything is written over it; an offset within `slop` of the top isn't worth restoring.
    public mutating func step(offset y: Double, saved: @autoclosure () -> Double?, now: TimeInterval) -> Action {
        if !started {
            started = true
            if let saved = saved(), abs(saved) > Self.slop {
                pending = (saved, now + Self.window)
                return .scrollTo(saved)
            }
        }
        guard let wanted = pending else { return .record(y) }
        if abs(y - wanted.y) < Self.slop || now > wanted.until {
            pending = nil
            return .none
        }
        return .scrollTo(wanted.y)
    }

    /// The person's own scroll wins over a restore still looking for its offset, and counts as the first reading.
    public mutating func interrupt() {
        started = true
        pending = nil
    }
}
