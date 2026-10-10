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

    /// The iPad's cards keep this far from the board column's trailing and bottom edges.
    public static let cornerMargin: CGFloat = 16
    /// From a card's ✕ tap target to the capsule's trailing edge.
    public static let closeInset: CGFloat = 10
    /// The widest and narrowest card worth showing (the narrowest keeps the ref and a few words).
    public static let maxCardWidth: CGFloat = 320
    public static let minCardWidth: CGFloat = 200
    /// The room a lone "N more…" card needs, margins included.
    public static let collapsedRoom: CGFloat = 150

    /// What the iPad's corner stack shows in a board column `width` wide.
    public enum CardMode: Equatable {
        /// Cards this wide.
        case cards(CGFloat)
        /// The "N more…" card alone, this wide, holding every docked ticket.
        case collapsed(CGFloat)
        case hidden
    }

    public static func cardMode(width: CGFloat) -> CardMode {
        let room = width - cornerMargin * 2
        if room >= minCardWidth { return .cards(min(maxCardWidth, room)) }
        return width >= collapsedRoom ? .collapsed(room) : .hidden
    }

    /// How many rows (cards and "N more…") fit a column `height` tall.
    public static func rowsFitting(height: CGFloat) -> Int {
        max(1, Int((height - cornerMargin * 2 + spacing) / (self.height + spacing)))
    }

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
