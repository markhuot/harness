import Foundation

// The model for Settings → Appearance's light/dark theme
// pickers, and the theme picks a settings deep link carries.

public enum ThemePicker {
    /// The theme fields of Prefs (`theme`, `lightTheme`, `darkTheme`).
    public struct ThemePrefs: Codable, Sendable, Equatable {
        public var theme: Prefs.ThemePreference
        public var lightTheme: String
        public var darkTheme: String

        public init(theme: Prefs.ThemePreference, lightTheme: String, darkTheme: String) {
            self.theme = theme
            self.lightTheme = lightTheme
            self.darkTheme = darkTheme
        }

        public init(_ prefs: Prefs) {
            self.init(theme: prefs.theme, lightTheme: prefs.lightTheme, darkTheme: prefs.darkTheme)
        }

        var choice: ThemeChoice { ThemeChoice(appearance: theme, lightTheme: lightTheme, darkTheme: darkTheme) }
    }

    /// `Partial<ThemePrefs>`: only the fields a deep link set validly. Encodes without the nil ones.
    public struct ThemePrefsPatch: Codable, Sendable, Equatable {
        public var theme: Prefs.ThemePreference?
        public var lightTheme: String?
        public var darkTheme: String?

        public init(theme: Prefs.ThemePreference? = nil, lightTheme: String? = nil, darkTheme: String? = nil) {
            self.theme = theme
            self.lightTheme = lightTheme
            self.darkTheme = darkTheme
        }

        /// These picks written over `prefs`.
        public func applied(to prefs: Prefs) -> Prefs {
            var p = prefs
            if let theme { p.theme = theme }
            if let lightTheme { p.lightTheme = lightTheme }
            if let darkTheme { p.darkTheme = darkTheme }
            return p
        }
    }

    public struct ThemeOption: Sendable, Equatable, Identifiable {
        public var theme: Theme
        /// The pick for this appearance (what a radio shows as checked)
        public var selected: Bool
        /// Selected and on screen right now
        public var active: Bool

        public var id: String { theme.id }
    }

    /// The pref a pick for an appearance writes (`themePrefKey`).
    public enum PrefKey: String, Codable, Sendable {
        case lightTheme, darkTheme

        public var keyPath: WritableKeyPath<Prefs, String> {
            switch self {
            case .lightTheme: \.lightTheme
            case .darkTheme: \.darkTheme
            }
        }
    }

    public static func themeOptions(_ appearance: ThemeAppearance, prefs: ThemePrefs, systemDark: Bool) -> [ThemeOption] {
        let picked = Themes.themeId(for: appearance, appearance == .light ? prefs.lightTheme : prefs.darkTheme)
        let onScreen = Themes.resolve(prefs.choice, systemDark: systemDark).theme.id
        return Themes.themes(for: appearance).map { ThemeOption(theme: $0, selected: $0.id == picked, active: $0.id == onScreen) }
    }

    /// The pref key a pick for this appearance writes.
    public static func themePrefKey(_ appearance: ThemeAppearance) -> PrefKey {
        appearance == .light ? .lightTheme : .darkTheme
    }

    /// Picker footer: whether this appearance's pick is what's on screen, and when it applies otherwise.
    public static func pickerCaption(_ appearance: ThemeAppearance, prefs: ThemePrefs, systemDark: Bool) -> String {
        let resolved = Themes.resolve(prefs.choice, systemDark: systemDark).appearance
        if resolved == appearance { return "In use now." }
        let name = appearance == .light ? "light" : "dark"
        if prefs.theme == .system { return "Used when iOS is in \(name) mode." }
        return "Used when Theme is \(appearance == .light ? "Light" : "Dark"), or System with iOS in \(name) mode."
    }

    /// Theme picks from a settings deep link (harness://settings?darkTheme=catppuccin-mocha&theme=dark),
    /// used to share a setup and by ios/Tools/sim-check.ts. Only valid values come back; anything
    /// else is dropped rather than falling back, so a bad link changes nothing.
    ///
    /// `params` is the link's params: a string, or an array for a repeated param (which is dropped).
    public static func themeLinkPrefs(_ params: [String: JSONValue]) -> ThemePrefsPatch {
        func one(_ k: String) -> String? { params[k]?.stringValue }
        var out = ThemePrefsPatch()
        if let light = one("lightTheme"), !light.isEmpty, Themes.themeId(for: .light, light) == light { out.lightTheme = light }
        if let dark = one("darkTheme"), !dark.isEmpty, Themes.themeId(for: .dark, dark) == dark { out.darkTheme = dark }
        if let appearance = one("theme").flatMap(Prefs.ThemePreference.init(rawValue:)) { out.theme = appearance }
        return out
    }

    /// `themeLinkPrefs` for a URL's query: a param given once is a string, a repeated one an array,
    /// and a param without a value is "".
    public static func themeLinkPrefs(queryItems: [URLQueryItem]) -> ThemePrefsPatch {
        var grouped: [String: [String]] = [:]
        for item in queryItems { grouped[item.name, default: []].append(item.value ?? "") }
        return themeLinkPrefs(grouped.mapValues { $0.count == 1 ? .string($0[0]) : .array($0.map(JSONValue.string)) })
    }
}
