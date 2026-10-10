import Foundation

/// The dock's measurements and labels (TicketDock, DockedCardStack): what sim-check's dock checks
/// used to recompute from the screen.
public enum DockMetrics {
    /// One docked card's height.
    public static let height: CGFloat = 64
    /// The gap between stacked cards.
    public static let spacing: CGFloat = 8
    /// How far the board's bottom bar sits above the docked cards, the same on every phone.
    public static let barGap: CGFloat = 11

    /// A stack of `rows` cards, gaps included.
    public static func stackHeight(rows: Int) -> CGFloat {
        rows > 0 ? CGFloat(rows) * height + CGFloat(rows - 1) * spacing : 0
    }

    /// The overflow card's label: "N more docked tickets" beside the shown cards, "N docked tickets"
    /// when it stands for all of them.
    public static func moreLabel(count: Int, all: Bool) -> String {
        all ? "\(count) docked tickets" : "\(count) more docked tickets"
    }
}
