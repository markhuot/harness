import Foundation

/// How the docked tickets show as minimized cards (the iPhone dock, the iPad's corner stack): up to
/// `maxVisible` cards for the most recently used, then one "N more…" card counting the rest, which
/// expands into a list of them all. `fitting` caps the rows (the "N more…" card included) when the
/// space is short, as on an iPad in a short window.
public enum DockCards {
    /// The iPhone's dock: two cards, then "N more…".
    public static let phoneVisible = 2
    /// The iPad's corner: five cards, then "N more…".
    public static let padVisible = 5

    /// The cards to show for `count` docked tickets, and what the "N more…" card counts (0: none).
    public static func split(count: Int, maxVisible: Int, fitting: Int? = nil) -> (cards: Int, more: Int) {
        guard count > 0 else { return (0, 0) }
        let rows = max(1, fitting ?? Int.max)
        if count <= maxVisible, count <= rows { return (count, 0) }
        let cards = max(0, min(maxVisible, rows - 1, count))
        return (cards, count - cards)
    }

    /// The rows the split takes: its cards plus the "N more…" card when there is one.
    public static func rows(count: Int, maxVisible: Int, fitting: Int? = nil) -> Int {
        let s = split(count: count, maxVisible: maxVisible, fitting: fitting)
        return s.cards + (s.more > 0 ? 1 : 0)
    }
}
