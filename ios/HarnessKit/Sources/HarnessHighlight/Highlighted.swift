import Foundation
import HarnessKit

// The result types of mobile/src/lib/highlight.ts, as the JavaScriptCore bundle returns them.

/// One colored run of text. `fontStyle` is Shiki's bit set: 1 italic, 2 bold, 4 underline.
public struct HighlightSpan: Codable, Sendable, Hashable {
    public var text: String
    /// A CSS color as the Shiki theme writes it (`#RRGGBB`, `#rrggbbaa`, any case); nil draws in `fg`.
    public var color: String?
    public var fontStyle: Int?

    public init(text: String, color: String? = nil, fontStyle: Int? = nil) {
        self.text = text
        self.color = color
        self.fontStyle = fontStyle
    }

    public var isItalic: Bool { (fontStyle ?? 0) & 1 != 0 }
    public var isBold: Bool { (fontStyle ?? 0) & 2 != 0 }
    public var isUnderline: Bool { (fontStyle ?? 0) & 4 != 0 }
}

/// What a diff line is, for its background and sign color: HarnessKit's `DiffLineKind` (diff.ts).
public typealias HighlightLineKind = DiffLineKind

public struct HighlightedLine: Codable, Sendable, Hashable {
    public var spans: [HighlightSpan]
    /// Set for diffs: what the line is, for its background and sign color
    public var kind: HighlightLineKind?

    public init(spans: [HighlightSpan], kind: HighlightLineKind? = nil) {
        self.spans = spans
        self.kind = kind
    }

    /// The line's text, spans joined.
    public var text: String { spans.map(\.text).joined() }
}

public struct Highlighted: Codable, Sendable, Hashable {
    public var lines: [HighlightedLine]
    /// The theme's default text color
    public var fg: String
    /// Git colors from the theme, for diff line tints (see `HighlightColors.diffTints`)
    public var added: String
    public var deleted: String

    public init(lines: [HighlightedLine], fg: String, added: String, deleted: String) {
        self.lines = lines
        self.fg = fg
        self.added = added
        self.deleted = deleted
    }

    public var git: GitColors { GitColors(added: added, deleted: deleted) }
}
