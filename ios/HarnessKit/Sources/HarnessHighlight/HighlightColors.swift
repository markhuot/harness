import Foundation
import HarnessKit

// gitColors and diffTints from mobile/src/lib/highlight.ts.

public struct GitColors: Codable, Sendable, Hashable {
    public var added: String
    public var deleted: String

    public init(added: String, deleted: String) {
        self.added = added
        self.deleted = deleted
    }
}

/// Line backgrounds for added and removed diff lines.
public struct DiffTints: Codable, Sendable, Hashable {
    public var add: String
    public var del: String

    public init(add: String, del: String) {
        self.add = add
        self.del = del
    }
}

public enum HighlightColors {
    /// Pierre's defaults (@pierre/diffs --diffs-added-*, --diffs-deleted-*) for themes without git colors.
    static func gitDefaults(_ appearance: ThemeAppearance) -> GitColors {
        switch appearance {
        case .light: GitColors(added: "#0dbe4e", deleted: "#ff6762")
        case .dark: GitColors(added: "#5ecc71", deleted: "#ff6762")
        }
    }

    /// The git colors a Shiki theme declares, picked the way @pierre/diffs picks them for the Git tab:
    /// gitDecoration colors, then the terminal's green/red, then Pierre's defaults.
    public static func gitColors(_ colors: [String: String]?, _ appearance: ThemeAppearance) -> GitColors {
        let d = gitDefaults(appearance)
        return GitColors(
            added: colors?["gitDecoration.addedResourceForeground"] ?? colors?["terminal.ansiGreen"] ?? d.added,
            deleted: colors?["gitDecoration.deletedResourceForeground"] ?? colors?["terminal.ansiRed"] ?? d.deleted
        )
    }

    /// Line backgrounds for a diff on `bg`, mixed like @pierre/diffs' --diffs-bg-addition/deletion:
    /// 12% of the git color in light themes, 20% in dark ones.
    public static func diffTints(_ bg: String, _ git: GitColors, _ appearance: ThemeAppearance) throws(CSSColorError) -> DiffTints {
        let amount = appearance == .dark ? 0.2 : 0.12
        return DiffTints(add: try CSSColor.mix(bg, git.added, amount), del: try CSSColor.mix(bg, git.deleted, amount))
    }
}
