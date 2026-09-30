import Foundation

/// One bundled color theme (shared/src/themes/types.ts `Theme`).
public struct Theme: Codable, Hashable, Sendable, Identifiable {
    /// Stable id, persisted in preferences ("catppuccin-mocha").
    public var id: String
    /// Display name ("Catppuccin Mocha").
    public var name: String
    public var appearance: ThemeAppearance
    /// Where the palette comes from.
    public var source: String
    /// Shiki / @pierre/diffs theme that matches, when one ships.
    public var syntaxTheme: String?
    public var tokens: ThemeTokens

    public init(id: String, name: String, appearance: ThemeAppearance, source: String, syntaxTheme: String?, tokens: ThemeTokens) {
        self.id = id
        self.name = name
        self.appearance = appearance
        self.source = source
        self.syntaxTheme = syntaxTheme
        self.tokens = tokens
    }

    private enum CodingKeys: String, CodingKey { case id, name, appearance, source, syntaxTheme, tokens }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        appearance = try c.decode(ThemeAppearance.self, forKey: .appearance)
        source = try c.decode(String.self, forKey: .source)
        // Required key whose value may be null (TS: `string | null`).
        syntaxTheme = try c.decode(String?.self, forKey: .syntaxTheme)
        tokens = try c.decode(ThemeTokens.self, forKey: .tokens)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(appearance, forKey: .appearance)
        try c.encode(source, forKey: .source)
        try c.encode(syntaxTheme, forKey: .syntaxTheme) // null, not omitted
        try c.encode(tokens, forKey: .tokens)
    }
}

/// What plugins receive about the active theme (harness:init / harness:theme), `pluginThemeInfo`.
public struct PluginThemeInfo: Codable, Hashable, Sendable {
    public var appearance: ThemeAppearance
    public var themeId: String
    public var themeName: String
    /// Shiki theme name matching the app theme, or null when none ships.
    public var syntaxTheme: String?
    public var tokens: ThemeTokens

    public init(_ theme: Theme) {
        appearance = theme.appearance
        themeId = theme.id
        themeName = theme.name
        syntaxTheme = theme.syntaxTheme
        tokens = theme.tokens
    }

    private enum CodingKeys: String, CodingKey { case appearance, themeId, themeName, syntaxTheme, tokens }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appearance = try c.decode(ThemeAppearance.self, forKey: .appearance)
        themeId = try c.decode(String.self, forKey: .themeId)
        themeName = try c.decode(String.self, forKey: .themeName)
        syntaxTheme = try c.decode(String?.self, forKey: .syntaxTheme)
        tokens = try c.decode(ThemeTokens.self, forKey: .tokens)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(appearance, forKey: .appearance)
        try c.encode(themeId, forKey: .themeId)
        try c.encode(themeName, forKey: .themeName)
        try c.encode(syntaxTheme, forKey: .syntaxTheme)
        try c.encode(tokens, forKey: .tokens)
    }
}

extension Theme {
    /// `pluginThemeInfo(theme)`.
    public var pluginInfo: PluginThemeInfo { PluginThemeInfo(self) }
}
