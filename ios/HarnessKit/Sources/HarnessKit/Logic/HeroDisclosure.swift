import Foundation

// Whether the ticket hero shows in full (crumb, title, badges, actions) or collapsed to its title
// line with a disclosure chevron. Every tab shares the one header. Only the Spec opens it in full;
// scrolling the Spec forward collapses it, and nothing but the disclosure expands it again: not
// scrolling back, not another tab, not news on the ticket.

public enum HeroDisclosure {
    /// Expanded when the screen opens on `tab`: only the Spec opens it in full.
    public static func expandedOnOpen(_ tab: TicketTab) -> Bool { tab == .spec }

    /// Expanded after moving to `tab`: any tab but the Spec collapses it; back on the Spec it stays
    /// as it was.
    public static func expanded(_ expanded: Bool, afterMovingTo tab: TicketTab) -> Bool { expanded && tab == .spec }

    /// Expanded after a scroll moved the hero collapse from `old` to `new` (HeroCollapse): a hide
    /// collapses it, and a show (scrolling back, reaching the top or the end) leaves it collapsed.
    public static func expanded(_ expanded: Bool, scrolledFrom old: Collapse, to new: Collapse) -> Bool {
        expanded && !(new.hidden && !old.hidden)
    }
}
