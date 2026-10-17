import Foundation

/// The dock's measurements and labels (TicketDock, DockedCardStack): what the UI tests' dock checks
/// used to recompute from the screen.
public enum DockMetrics {
    /// One docked card's height: the ✕'s 44pt tap target with 4pt above and below.
    public static let height: CGFloat = 52
    /// The gap between stacked cards.
    public static let spacing: CGFloat = 8
    /// How far the board's bottom bar sits above the docked cards, the same on every phone.
    public static let barGap: CGFloat = 11
    /// The iPhone's docked cards float this far from the bottom safe area (the home indicator).
    public static let phoneBottomGap: CGFloat = 8
    /// The board's bottom bar's height, and its side gap where the screen has no corners to follow
    /// (landscape, not yet measured): the docked cards take the bar's sides.
    public static let barHeight: CGFloat = 50
    public static let fallbackSides: CGFloat = 16

    /// How far the iPhone's docked cards sit from the screen's sides: the board's bottom bar's
    /// concentric inset (ConcentricBar), so the cards and the bar share their left and right edges.
    public static func phoneSides(screen: ConcentricBar.Screen?) -> CGFloat {
        ConcentricBar.padding(screen, barHeight: barHeight)?.horizontal ?? fallbackSides
    }

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

    /// What a phone section gives up at its bottom so the whole card stack sits under the board's bar:
    /// everything below the stack's measured top edge, less the home indicator's inset the section
    /// already keeps clear. Before the stack is measured, `rows` cards, their gaps and the bottom gap.
    /// It never depends on the keyboard: the cards stay put behind it.
    public static func clearance(screenHeight: CGFloat?, stackTop: CGFloat?, homeIndicator: CGFloat, rows: Int) -> CGFloat {
        guard let screenHeight, let stackTop else {
            return max(0, stackHeight(rows: max(1, rows)) + phoneBottomGap - homeIndicator + 19)
        }
        // Never less than `rows` cards need: a stale or mid-transition measurement (the stack's top
        // at or below the screen's bottom) would otherwise leave the bar under the cards.
        let floor = stackHeight(rows: max(1, rows)) + phoneBottomGap - homeIndicator
        return max(0, floor, screenHeight - stackTop - homeIndicator)
    }

    /// The overflow card's label: "N more docked tickets" beside the shown cards, "N docked tickets"
    /// when it stands for all of them.
    public static func moreLabel(count: Int, all: Bool) -> String {
        all ? "\(count) docked tickets" : "\(count) more docked tickets"
    }
}
