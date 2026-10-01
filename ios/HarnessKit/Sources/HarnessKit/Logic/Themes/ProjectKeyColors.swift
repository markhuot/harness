import Foundation
import Synchronization

// Port of shared/src/themes/projectColor.ts: a project key badge in the active theme. A soft wash
// of the project's color with the color as text, nudged toward the theme's ink only as far as AA
// needs on every surface the badge sits on. No color → the theme's accent badge.

public struct ProjectKeyColors: Codable, Hashable, Sendable {
    /// Badge fill (CSS color).
    public var bg: String
    /// Badge text (CSS color).
    public var fg: String

    public init(bg: String, fg: String) {
        self.bg = bg
        self.fg = fg
    }

    private static let aa = 4.5
    private static let cache = Mutex<[String: ProjectKeyColors]>([:])

    /// `projectKeyColors(color, tokens)`. Where the TS would throw on an unparseable surface token
    /// (never for bundled themes), this falls back to the accent badge instead.
    public static func `for`(_ color: String?, tokens: ThemeTokens) -> ProjectKeyColors {
        let accent = ProjectKeyColors(bg: tokens.accentSoft, fg: tokens.accentText)
        guard let hex = ProjectColors.hex(color) else { return accent }
        let id = "\(hex)|\(tokens.bg)|\(tokens.bgElev)|\(tokens.bgSidebar)|\(tokens.bgColumn)"
        if let hit = cache.withLock({ $0[id] }) { return hit }
        do {
            let light = CSSColor.luminance(try CSSColor.parse(tokens.bg).rgb) > 0.5
            let bg = try CSSColor.alpha(hex, light ? 0.14 : 0.2)
            // Sidebar, board, cards and headers: the wash composited over each.
            let backdrops = try [tokens.bg, tokens.bgElev, tokens.bgSidebar, tokens.bgColumn].map { s throws(CSSColorError) in
                CSSColor.toHex(try CSSColor.over(bg, s))
            }
            let fg = try CSSColor.readable(hex, backdrops: backdrops, min: aa, toward: light ? "#000000" : "#ffffff")
            let out = ProjectKeyColors(bg: bg, fg: fg)
            cache.withLock {
                if $0.count > 500 { $0.removeAll() }
                $0[id] = out
            }
            return out
        } catch {
            return accent
        }
    }
}
