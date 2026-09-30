import Foundation

// Port of shared/src/themes/syntax.ts: which Shiki theme code is highlighted with. The app theme's
// matching Shiki theme (Theme.syntaxTheme), or Pierre's own light/dark theme when there's none or
// its name failed to resolve.

/// A Shiki theme per appearance: @pierre/diffs' `theme` option.
public struct ViewerThemes: Codable, Hashable, Sendable {
    public var light: String
    public var dark: String

    public init(light: String, dark: String) {
        self.light = light
        self.dark = dark
    }

    public subscript(appearance: ThemeAppearance) -> String {
        get { appearance == .light ? light : dark }
        set { if appearance == .light { light = newValue } else { dark = newValue } }
    }
}

public enum SyntaxTheme {
    /// `PIERRE_DEFAULT`.
    public static let pierreDefault = ViewerThemes(light: "pierre-light", dark: "pierre-dark")

    /// `syntaxThemeName`: `syntaxTheme` when it's a plausible Shiki name (/^[a-z0-9][a-z0-9-]{0,63}$/)
    /// that hasn't failed to load, else Pierre's default for the appearance.
    public static func name(_ appearance: ThemeAppearance, _ syntaxTheme: String?, failed: Set<String> = []) -> String {
        if let s = syntaxTheme, isName(s), !failed.contains(s) { return s }
        return pierreDefault[appearance]
    }

    /// `viewerThemes`: the chosen theme in the active slot, Pierre's default in the other.
    public static func viewerThemes(_ appearance: ThemeAppearance, _ name: String) -> ViewerThemes {
        var v = pierreDefault
        v[appearance] = name
        return v
    }

    static func isName(_ s: String) -> Bool {
        let u = Array(s.unicodeScalars)
        guard (1...64).contains(u.count) else { return false }
        func ok(_ c: Unicode.Scalar, dash: Bool) -> Bool {
            ("a"..."z").contains(c) || ("0"..."9").contains(c) || (dash && c == "-")
        }
        return ok(u[0], dash: false) && u.dropFirst().allSatisfy { ok($0, dash: true) }
    }
}
