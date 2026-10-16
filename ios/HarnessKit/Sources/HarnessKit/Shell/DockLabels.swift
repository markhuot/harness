/// The words on a docked card: its menu line and its VoiceOver name (which the walkthrough reads too).
public enum DockLabels {
    /// A menu row's one line: "<ref> · <title>", or the ref alone with no title.
    public static func menuLine(ref: String, title: String?) -> String {
        [ref, title].compactMap { $0 }.joined(separator: " · ")
    }

    /// "<ref>, <title>, docked", or "<ref>, docked" with no title.
    public static func accessibilityLabel(ref: String, title: String?) -> String {
        [ref, title, "docked"].compactMap { $0 }.joined(separator: ", ")
    }
}
