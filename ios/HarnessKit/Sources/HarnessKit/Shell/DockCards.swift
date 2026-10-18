import Foundation

/// How the docked tickets show as minimized cards (the iPhone dock, the iPad's corner stack): up to
/// `maxVisible + 1` cards show as they are; past that, `maxVisible` cards for the most recently used
/// and one "N more…" card counting the rest, which expands into a list of them all. `fitting` caps
/// the rows (the "N more…" card included) when the space is short, as on an iPad in a short window.
public enum DockCards {
    /// The iPhone's dock: two cards and a "N more…" row, three rows; three cards fill them all.
    public static let phoneVisible = 2
    /// The iPad's corner: five cards and a "N more…" row, six rows; six cards fill them all.
    public static let padVisible = 5

    /// The cards to show for `count` docked tickets, and what the "N more…" card counts (0: none).
    public static func split(count: Int, maxVisible: Int, fitting: Int? = nil) -> (cards: Int, more: Int) {
        guard count > 0 else { return (0, 0) }
        let rows = max(1, fitting ?? Int.max)
        // The "N more…" row would take a row of its own, so it only appears once the cards outnumber
        // the rows the dock has: `maxVisible` cards plus that row.
        if count <= maxVisible + 1, count <= rows { return (count, 0) }
        let cards = max(0, min(maxVisible, rows - 1, count))
        return (cards, count - cards)
    }

    /// The rows the split takes: its cards plus the "N more…" card when there is one.
    public static func rows(count: Int, maxVisible: Int, fitting: Int? = nil) -> Int {
        let s = split(count: count, maxVisible: maxVisible, fitting: fitting)
        return s.cards + (s.more > 0 ? 1 : 0)
    }

    /// Whether the phone's dock is on screen: there are cards to draw (or the hold-to-dock ghost, which
    /// takes a slot of its own) and nothing is over the ticket that the cards would sit on top of
    /// wrongly. A keyboard, a sheet (a picker, the palette), a full-screen cover or a dialog hides it;
    /// it comes back when they go.
    public static func isShown(count: Int, ghost: Bool = false, sheetUp: Bool, coverUp: Bool, keyboardUp: Bool, dialogUp: Bool) -> Bool {
        (count > 0 || ghost) && !sheetUp && !coverUp && !keyboardUp && !dialogUp
    }

    /// Something the Router doesn't own is presented over the ticket: an alert, the share sheet, a
    /// picker, or any SwiftUI sheet, popover or cover a screen opens itself. The dock is only shown
    /// with no Router sheet or cover up, so the one presentation it expects is the ticket sheet
    /// (`expected` 1); a deeper chain of live presentations is a stranger's, whatever its class.
    public static func dialogUp(presentedDepth: Int, expected: Int) -> Bool {
        presentedDepth > expected
    }
}
