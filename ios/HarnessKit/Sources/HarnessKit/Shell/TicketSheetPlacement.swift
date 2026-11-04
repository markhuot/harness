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

/// The ticket sheet's full height, from the readings of its size, and whether it is shorter than
/// that because it moved. The system resizes the sheet under a finger (and through its spring back),
/// so a drag would hand the content a new height every frame and re-lay it out. Moved, the content
/// keeps its full-height layout and the sheet clips it instead. The keyboard shrinks the sheet too:
/// that height the content follows, so the composer rides above the keyboard. (The sheet's top in
/// the window can't tell the two apart: quarter open, UIKit reports the sheet at y 0.)
public struct TicketSheetRest: Sendable, Equatable {
    /// The tallest the sheet has been at each width it has had. Per width, not just the latest: on
    /// its way to quarter open the sheet passes through a narrower inset width for a frame, and
    /// forgetting the full height there would pin the content at the short height once it's back.
    private var fullHeights: [Double: Double] = [:]
    private var width: Double?
    private var height: Double?
    /// The keyboard accounts for the sheet's height: it is up, on its way, or on its way down with
    /// the sheet still growing back.
    public private(set) var keyboardUp = false
    /// The keyboard is on its way down: the sheet grows back with it, and the content follows that
    /// growth until the sheet is back at full height (or the keyboard is gone).
    private var keyboardLeaving = false

    /// Less than this short of full height is rounding, not a move.
    static let tolerance = 0.5

    public init() {}

    /// The tallest the sheet has been at its current width: its full height.
    public var fullHeight: Double? { width.flatMap { fullHeights[$0] } }

    /// A reading of the sheet's size. Each width (a rotation) has a full height of its own.
    public mutating func read(width: Double, height: Double) {
        self.width = width
        self.height = height
        fullHeights[width] = max(fullHeights[width] ?? 0, height)
        // Back at full height as the keyboard leaves: from here, a shorter sheet is a move again.
        if keyboardLeaving, let fullHeight, height >= fullHeight - Self.tolerance { keyboardGone() }
    }

    /// The keyboard is showing, or about to.
    public mutating func keyboardWillShow() {
        keyboardUp = true
        keyboardLeaving = false
    }

    /// The keyboard is about to hide. The sheet is still short for it and grows back as it goes, so
    /// the content keeps following the sheet until a reading finds it back at full height: ending
    /// the exemption now would pin the content at full height mid-dismiss, dropping the composer
    /// from above the keyboard to the clipped bottom.
    public mutating func keyboardWillHide() {
        if keyboardUp { keyboardLeaving = true }
    }

    /// The keyboard is gone. If the sheet never got back to full height (a drag took it down as
    /// the keyboard left), it is displaced from here.
    public mutating func keyboardDidHide() { keyboardGone() }

    private mutating func keyboardGone() {
        keyboardUp = false
        keyboardLeaving = false
    }

    /// The sheet is shorter than full height without the keyboard to account for it: dragged,
    /// springing back, or resting at a lower stop.
    public var displaced: Bool {
        guard !keyboardUp, let height, let fullHeight else { return false }
        return height < fullHeight - Self.tolerance
    }

    /// Whether the content keeps its full-height layout rather than the sheet's current height.
    public func pinsContent(quarterOpen: Bool) -> Bool { quarterOpen || displaced }

    /// Equal when nothing the layout reads differs: a drag changes the height every frame, but only
    /// leaving or reaching full height counts, so the view keeping this updates twice a drag.
    public static func == (a: Self, b: Self) -> Bool {
        a.width == b.width && a.fullHeight == b.fullHeight && a.keyboardUp == b.keyboardUp && a.displaced == b.displaced
    }
}
