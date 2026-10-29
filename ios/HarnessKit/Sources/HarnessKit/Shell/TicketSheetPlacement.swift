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

    public static func placement(for posture: DevicePosture) -> TicketSheetPlacement {
        posture == .book ? .trailing : .system
    }
}
