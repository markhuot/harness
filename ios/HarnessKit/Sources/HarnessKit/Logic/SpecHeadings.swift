import Foundation

/// The size and spacing rules for headings in a rendered spec (MarkdownView draws them; sim-check
/// only confirms they reach the screen).
public enum SpecHeadings {
    /// A heading's text size: a scale down from the body size + 7 pt (level 1) through +4, +2 and +0.5.
    public static func size(level: Int, body: CGFloat) -> CGFloat {
        switch level {
        case 1: body + 7
        case 2: body + 4
        case 3: body + 2
        default: body + 0.5
        }
    }

    /// The space added over the stack's 8 pt and the heading's own 2 pt, so a heading sits
    /// `headingSpace` × its size below the block before it. A heading straight after another heading
    /// (`previous`) gets none of that and pulls in 4 pt closer than the usual gap. Nothing for a
    /// block that isn't a heading, or when `headingSpace` is off.
    public static func lead(level: Int?, after previous: Int?, headingSpace: CGFloat, body: CGFloat) -> CGFloat {
        guard let level else { return 0 }
        if previous != nil { return -4 }
        guard headingSpace > 0 else { return 0 }
        return max(0, (headingSpace * size(level: level, body: body)).rounded() - 10)
    }
}
