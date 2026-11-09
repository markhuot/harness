// Seen and unseen (DESIGN.md "Seen and unseen"): when a ticket's detail marks the ticket seen. The
// Mac's useMarkSeen hook follows the same rules.

public enum SeenRules {
    /// The detail gained focus (or its ticket loaded while focused): only an unseen ticket needs the write.
    public static func markOnFocus(focused: Bool, ticket: Ticket?) -> Bool {
        focused && ticket?.unseen == true
    }

    /// The newest Activity entry an agent or the system wrote: what a focused detail watches.
    public static func latestNonHuman(_ entries: [ActivityEntry]?) -> String? {
        entries?.last(where: { $0.author != .human })?.id
    }

    /// New agent or system Activity arrived while the detail has focus. The first load of the list
    /// (`previous` nil) isn't new activity. It never looks at the unseen flag, so "Mark ticket unseen"
    /// from a focused detail stays unseen.
    public static func markOnActivity(focused: Bool, previous: String?, latest: String?) -> Bool {
        focused && previous != nil && latest != nil && previous != latest
    }
}
