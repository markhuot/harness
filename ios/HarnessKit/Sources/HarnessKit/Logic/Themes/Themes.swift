import Foundation

// Port of shared/src/themes/index.ts (all but the CSS-only helpers: themeCssVars, themeCssText,
// applyThemeVars). The data comes from Resources/themes.json, generated from shared/src by
// shared/fixtures/resources/themes.ts, so the palettes are never hand-copied.
//
// Appearance stays System / Light / Dark. The user also picks one light theme and one dark theme;
// the active theme is the light pick when the resolved appearance is light, the dark pick when dark.

/// Resources/themes.json, decoded.
struct ThemesResource: Decodable, Sendable {
    let THEMES: [Theme]
    let DEFAULT_LIGHT_THEME: String
    let DEFAULT_DARK_THEME: String
    let PROJECT_COLORS: [ProjectColor]
    let ICON_PATHS: [String: String]
    let ICON_NAMES: [String]

    static func decode(_ data: Data) throws -> ThemesResource {
        try JSONDecoder().decode(ThemesResource.self, from: data)
    }

    /// The bundled resource. It's generated and checked by tests, so a failure here is a build bug.
    static let bundled: ThemesResource = {
        do {
            guard let url = Bundle.module.url(forResource: "themes", withExtension: "json", subdirectory: "Resources") else {
                throw CocoaError(.fileNoSuchFile)
            }
            return try decode(Data(contentsOf: url))
        } catch {
            fatalError("HarnessKit Resources/themes.json: \(error)")
        }
    }()
}

/// The Appearance preference: follow the system, or force light or dark.
public enum AppearancePreference: String, Codable, Hashable, Sendable, CaseIterable {
    case system
    case light
    case dark
}

/// What the user picked: an appearance plus one light and one dark theme id.
public struct ThemeChoice: Codable, Hashable, Sendable {
    public var appearance: AppearancePreference
    public var lightTheme: String
    public var darkTheme: String

    public init(appearance: AppearancePreference, lightTheme: String, darkTheme: String) {
        self.appearance = appearance
        self.lightTheme = lightTheme
        self.darkTheme = darkTheme
    }
}

/// A choice after applying System: the concrete appearance and the theme to draw with.
public struct ResolvedThemeChoice: Hashable, Sendable {
    public var appearance: ThemeAppearance
    public var theme: Theme
}

public enum Themes {
    /// Every bundled theme, light then dark, in picker order (THEMES).
    public static let all: [Theme] = ThemesResource.bundled.THEMES
    public static let defaultLightTheme: String = ThemesResource.bundled.DEFAULT_LIGHT_THEME
    public static let defaultDarkTheme: String = ThemesResource.bundled.DEFAULT_DARK_THEME

    private static let byId: [String: Theme] = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

    /// The default theme id for an appearance.
    public static func defaultThemeId(for appearance: ThemeAppearance) -> String {
        appearance == .light ? defaultLightTheme : defaultDarkTheme
    }

    /// `findTheme`: the theme with exactly this id.
    public static func find(_ id: String?) -> Theme? {
        id.flatMap { byId[$0] }
    }

    /// `findTheme(unknown)`: only a JSON string can name a theme.
    public static func find(_ id: JSONValue?) -> Theme? {
        find(id?.stringValue)
    }

    /// `themesFor`: the themes of one appearance, in picker order.
    public static func themes(for appearance: ThemeAppearance) -> [Theme] {
        all.filter { $0.appearance == appearance }
    }

    /// `themeIdFor`: a stored id if it names a theme of that appearance, else the default for it.
    public static func themeId(for appearance: ThemeAppearance, _ id: String?) -> String {
        if let t = find(id), t.appearance == appearance { return t.id }
        return defaultThemeId(for: appearance)
    }

    public static func themeId(for appearance: ThemeAppearance, _ id: JSONValue?) -> String {
        themeId(for: appearance, id?.stringValue)
    }

    /// `isAppearancePreference`.
    public static func isAppearancePreference(_ v: JSONValue?) -> Bool {
        appearancePreference(v) != nil
    }

    static func appearancePreference(_ v: JSONValue?) -> AppearancePreference? {
        v?.stringValue.flatMap(AppearancePreference.init(rawValue:))
    }

    /// `normalizeThemeChoice`: anything stored (old preference files, hand edits) as a valid choice.
    /// Only a JSON object contributes fields; anything else is all defaults.
    public static func normalizeThemeChoice(_ v: JSONValue?) -> ThemeChoice {
        ThemeChoice(
            appearance: appearancePreference(v?["appearance"]) ?? .system,
            lightTheme: themeId(for: .light, v?["lightTheme"]),
            darkTheme: themeId(for: .dark, v?["darkTheme"])
        )
    }

    /// `normalizeThemeChoice` for already-typed fields (a nil field is missing).
    public static func normalizeThemeChoice(appearance: String?, lightTheme: String?, darkTheme: String?) -> ThemeChoice {
        ThemeChoice(
            appearance: appearance.flatMap(AppearancePreference.init(rawValue:)) ?? .system,
            lightTheme: themeId(for: .light, lightTheme),
            darkTheme: themeId(for: .dark, darkTheme)
        )
    }

    /// `resolveThemeChoice`: apply System, then pick that appearance's theme (falling back to the
    /// default when the stored pick is unknown or of the other appearance).
    public static func resolve(_ choice: ThemeChoice, systemDark: Bool) -> ResolvedThemeChoice {
        let appearance: ThemeAppearance = switch choice.appearance {
        case .system: systemDark ? .dark : .light
        case .light: .light
        case .dark: .dark
        }
        let id = themeId(for: appearance, appearance == .light ? choice.lightTheme : choice.darkTheme)
        return ResolvedThemeChoice(appearance: appearance, theme: find(id)!)
    }
}
