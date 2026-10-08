import Foundation

/// How a drag on the iPhone's ticket sheet let go, for one that should send it away rather than
/// dock it. The system only ever settles a drag from `.large` on the dock, however hard it was
/// flung, and SwiftUI's detent selection says where it settled but not how fast it was moving, so
/// the app reads that from a pan of its own (`began` / `ended` / `cancelled`) and asks here once the
/// sheet settles (`settled`).
///
/// The two arrive in the same touch, in whichever order UIKit tells its recognizers, so the answer
/// comes as soon as both are in: no frame shows the sheet docked on its way out, which would have
/// the board make room for the dock and give it back.
@MainActor public final class SheetFlick {
    public enum Outcome: Equatable, Sendable { case dock, dismiss }

    /// Downward speed at release (pt/s) past which a drag from `.large` sends the sheet away. A
    /// deliberate swipe lets go well above it; one that slows toward the bottom lets go well below.
    public static let speed: Double = 1000
    /// How far apart letting go and the sheet settling may be and still be the same drag.
    public static let window: TimeInterval = 0.3

    /// A finger is on the sheet: what the sheet measures now isn't where it rests.
    public private(set) var isDragging = false
    private var release: (velocity: Double, at: Date)?
    private var waiting: (at: Date, decide: (Outcome) -> Void)?

    public init() {}

    public func began() {
        isDragging = true
        release = nil
    }

    /// Let go moving down at `velocity` (pt/s, down positive).
    public func ended(velocity: Double, at: Date) {
        isDragging = false
        release = (velocity, at)
        resolve()
    }

    public func cancelled() {
        isDragging = false
        release = nil
        resolve()
    }

    /// The sheet settled on the dock from `.large` at `at`. `decide` gets the outcome now if the drag
    /// has let go (or there was none), else when it does.
    public func settled(at: Date, decide: @escaping (Outcome) -> Void) {
        waiting = (at, decide)
        if !isDragging { resolve() }
    }

    /// Stops waiting on a release that never came, and docks.
    public func flush() {
        guard let waiting else { return }
        self.waiting = nil
        waiting.decide(.dock)
    }

    private func resolve() {
        guard let waiting else { return }
        self.waiting = nil
        waiting.decide(outcome(settledAt: waiting.at))
    }

    private func outcome(settledAt: Date) -> Outcome {
        guard let release, abs(settledAt.timeIntervalSince(release.at)) < Self.window,
              release.velocity > Self.speed else { return .dock }
        return .dismiss
    }
}
