import Foundation

/// How a two-screen foldable (the iPhone Duo) is held. Everywhere else the posture is `.flat`.
public enum DevicePosture: Sendable, Equatable {
    /// Fully open, a single screen, or any hold that isn't the book pose.
    case flat
    /// Partly open with the fold running vertically, so each half of the screen is its own page.
    case book

    /// The posture from what the hinge reports: partly open counts as the book pose while the window
    /// is wider than it is tall (the vertical fold: two portrait halves side by side). Partly open
    /// with a tall window is the fold running the other way, which the sheet doesn't treat specially.
    public static func resolve(hingePartlyOpen: Bool, windowWidth: Double, windowHeight: Double) -> DevicePosture {
        hingePartlyOpen && windowWidth > windowHeight ? .book : .flat
    }
}

/// Where the system places the ticket sheet. It always rises from the bottom; the one exception is
/// the Duo in the book pose, where it covers only the right half of the screen. The fully open
/// Duo and every other device keep the system's own placement.
public enum TicketSheetPlacement: Sendable, Equatable {
    /// Whatever the system does (centered form sheet at regular width, full width at compact).
    case system
    /// The trailing half of the screen.
    case trailing

    /// The sheet's lower stop, next to full height, as a fraction of that height: a quarter, so most
    /// of the board shows (and works) above it. DockArming's zone starts below its top edge.
    public static let peekFraction = 0.25

    /// Whether the sheet comes up at full height after the top ticket changed (a card tapped on the
    /// live board docks the quarter-open ticket and opens the tapped one). A sheet already at full
    /// height stays there.
    public static func opensFullHeightAfterTicketChange(quarterOpen: Bool) -> Bool { quarterOpen }

    public static func placement(for posture: DevicePosture) -> TicketSheetPlacement {
        posture == .book ? .trailing : .system
    }
}

/// The ticket sheet's full-height place, from the readings of its frame on screen, and whether it
/// has left it. The system resizes the sheet under a finger (and through its spring back), so a
/// drag would hand the content a new height every frame and re-lay it out. Off its place, the
/// content keeps its full-height layout and the sheet clips it instead. The keyboard shrinks the
/// sheet too, but leaves its top where it was: that one the content follows, so the composer rides
/// above the keyboard.
public struct TicketSheetRest: Sendable, Equatable {
    /// The tallest the sheet has been at this width: its full height.
    public private(set) var fullHeight: Double?
    /// The highest its top has been at this width: where it rests at full height.
    public private(set) var restTop: Double?
    private var width: Double?
    private var top: Double?

    /// Less than this off its place is rounding, not a move.
    static let tolerance = 0.5

    public init() {}

    /// A reading of the sheet's frame in the window. A new width (a rotation) starts over.
    public mutating func read(width: Double, height: Double, top: Double) {
        if width != self.width {
            self.width = width
            fullHeight = nil
            restTop = nil
        }
        if height > (fullHeight ?? 0) { fullHeight = height }
        if top < (restTop ?? .infinity) { restTop = top }
        self.top = top
    }

    /// The sheet's top is below its full-height place: dragged, springing back, or resting at a
    /// lower stop.
    public var displaced: Bool {
        guard let top, let restTop else { return false }
        return top > restTop + Self.tolerance
    }

    /// Whether the content keeps its full-height layout rather than the sheet's current height.
    public func pinsContent(quarterOpen: Bool) -> Bool { quarterOpen || displaced }

    /// Equal when nothing the layout reads differs: a drag moves the top every frame, but only
    /// leaving or reaching the place counts, so the view keeping this updates twice a drag.
    public static func == (a: Self, b: Self) -> Bool {
        a.width == b.width && a.fullHeight == b.fullHeight && a.restTop == b.restTop && a.displaced == b.displaced
    }
}
