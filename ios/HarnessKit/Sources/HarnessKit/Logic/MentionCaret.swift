import Foundation

/// Port of mobile/src/lib/mentionCaret.ts: the caret bookkeeping behind @-mention and /command
/// autocomplete in the composer, apart from the view. Where the caret is, and the selection the
/// input is forced to after a pick so the caret lands after the inserted mention or command.
///
/// Offsets are UTF-16 code units (NSRange, `String.utf16Offset(in:)`).
///
/// The RN quirk it works around: after a pick replaces the text and sets the selection, iOS reports
/// the caret from before the pick once more, and doesn't always report the forced caret at all. A
/// SwiftUI `TextEditor(text:selection:)` (UITextView underneath) behaves the same way: replacing the
/// text moves UITextView's selection, and that change reaches the selection binding separately from
/// (and possibly after) the selection the pick wrote. So the whole state machine applies.
///
/// What's RN-only is how the forced selection is applied. RN's `selection` prop is controlled only
/// while one is forced (`selectionProp` returns undefined otherwise, leaving the TextInput free). A
/// SwiftUI selection binding is always two-way, so `forcedSelection` is the value to write into the
/// binding when a pick happens; the view doesn't need to keep re-applying it.
public struct MentionCaret: Codable, Equatable, Sendable {
    /// The collapsed caret, or nil for no caret or a range selection.
    public var at: Int?
    /// The selection forced on the input after a pick, until the input reports a newer one.
    public var forced: Int?
    /// While forced: the caret from before the pick, which iOS may report once more.
    public var stale: Int?

    public init(at: Int? = nil, forced: Int? = nil, stale: Int? = nil) {
        self.at = at
        self.forced = forced
        self.stale = stale
    }

    /// `NO_CARET`: the input hasn't reported a selection yet.
    public static let none = MentionCaret()

    /// A collapsed selection at a UTF-16 offset.
    public struct Selection: Codable, Equatable, Sendable {
        public var start: Int
        public var end: Int
        public init(start: Int, end: Int) {
            self.start = start
            self.end = end
        }
    }

    /// The input reported a selection. A range means no mention. A stale report of the caret from
    /// before the pick (iOS sends one) keeps the forced selection; any other report releases it.
    /// iOS doesn't always report the forced caret itself, and holding it until then would pin the
    /// caret there, so each typed character would land before the last one.
    public func onSelection(start: Int, end: Int) -> MentionCaret {
        let keep = forced != nil && start == end && start == stale && start != forced
        return keep ? self : MentionCaret(at: start == end ? start : nil)
    }

    /// A pick replaced the mention (the caret was at `before`): the caret goes after it, and the
    /// input is held there.
    public static func onPick(_ caret: Int, before: Int? = nil) -> MentionCaret {
        MentionCaret(at: caret, forced: caret, stale: before)
    }

    /// The mention being typed at the caret, if any (the caret can outrun a value that was just
    /// replaced).
    public func mentionAt(_ value: String) -> ActiveMention? {
        guard let at, at <= value.utf16.count else { return nil }
        return Mentions.activeMention(value, caret: at)
    }

    /// The /command being typed at the caret, if any.
    public func commandAt(_ value: String) -> ActiveCommand? {
        guard let at, at <= value.utf16.count else { return nil }
        return Commands.activeCommand(value, caret: at)
    }

    /// `selectionProp`: the selection to force on the input, only while one is forced.
    public var forcedSelection: Selection? {
        forced.map { Selection(start: $0, end: $0) }
    }
}
