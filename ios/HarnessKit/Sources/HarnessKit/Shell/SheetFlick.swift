import Foundation

/// What letting go of a drag on an open ticket does, on the iPhone's sheet (dragged down) and the
/// iPad's side panel (dragged right): one rule for both.
///
/// - **Fast** (past `speed` toward the way out): dismisses, however short the drag. This is the only
///   gesture that dismisses.
/// - **Slow, `fraction` or more of the way** from open to the edge: docks.
/// - **Anything else**: springs back to open.
///
/// The system sheet only ever settles a drag from `.large` on the dock, and SwiftUI's detent
/// selection says where it settled but not how the finger let go, so the app reads the release from
/// a pan of its own and decides there (`ended`), the moment the finger lifts. The speed is UIKit's,
/// worked out from the touches' hardware timestamps, so a busy main thread can't change it, and the
/// system's later settle (`settled`) only confirms a decision already made: nothing pairs the two by
/// the clock.
@MainActor public final class SheetFlick {
    public enum Outcome: Equatable, Sendable { case dismiss, dock, restore }

    /// Speed at release (pt/s) toward the way out past which a drag dismisses. A deliberate drag lets
    /// go well below it.
    public nonisolated static let speed: Double = 600
    /// How much of the travel a slow drag has to cover to dock rather than spring back.
    public nonisolated static let fraction: Double = 0.6

    /// The rule. `velocity` is toward the way out (pt/s, positive), `distance` how far the drag went
    /// that way from open (negative back past it) and `travel` the whole way to the edge.
    public nonisolated static func outcome(velocity: Double, distance: Double, travel: Double) -> Outcome {
        if velocity > speed { return .dismiss }
        if travel > 0, distance >= travel * fraction { return .dock }
        return .restore
    }

    /// A finger is on the sheet: what the sheet measures now isn't where it rests.
    public private(set) var isDragging = false
    /// What the last release decided, until the system's settle (or the next drag) has seen it.
    private var released: Outcome?
    private var waiting: ((Outcome) -> Void)?

    public init() {}

    public func began() {
        isDragging = true
        released = nil
        waiting = nil
    }

    /// Let go: decides now, tells `apply`, and tells a settle that came first. `distance` is how far
    /// the sheet itself moved, not the finger: a drag that never moved it (it scrolled the ticket's
    /// content, say) decides nothing, whatever its speed, and returns nil.
    @discardableResult
    public func ended(velocity: Double, distance: Double, travel: Double, apply: (Outcome) -> Void) -> Outcome? {
        guard distance > 0 else {
            cancelled()
            return nil
        }
        isDragging = false
        let outcome = Self.outcome(velocity: velocity, distance: distance, travel: travel)
        released = outcome
        apply(outcome)
        resolve(outcome)
        return outcome
    }

    /// The drag was interrupted: the system's settle stands.
    public func cancelled() {
        isDragging = false
        released = nil
        resolve(.dock)
    }

    /// The sheet settled on the dock from `.large`. `decide` gets what to do now: what the release
    /// decided if it's in, when it comes if the finger is still down, and a dock if there was no drag
    /// at all.
    public func settled(decide: @escaping (Outcome) -> Void) {
        if let released {
            self.released = nil
            decide(released)
        } else if isDragging {
            waiting = decide
        } else {
            decide(.dock)
        }
    }

    private func resolve(_ outcome: Outcome) {
        guard let waiting else { return }
        self.waiting = nil
        released = nil
        waiting(outcome)
    }
}
