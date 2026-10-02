import Foundation

// The preferences blob (persisted in the Keychain).
//
// The stored blob is whatever an older build (the 1.x React Native app included) or a hand edit
// left, so `normalizePrefs` reads it as JSONValue: its fields are laid over the defaults, a
// non-string `lastProject`, `boardProject` or `activeServer` becomes nil, and unknown keys are
// dropped.

public struct Prefs: Codable, Sendable, Equatable {
    /// The Appearance preference stored in prefs (`ThemePreference`: "system" | "light" | "dark").
    public typealias ThemePreference = AppearancePreference

    /// Appearance: System / Light / Dark
    public var theme: ThemePreference
    /// Theme id used when the resolved appearance is light / dark (see Themes)
    public var lightTheme: String
    public var darkTheme: String
    /// Board: hide child tickets (the blocked / awaiting-approval ones always show). First run: hidden, like the desktop.
    public var hideChildren: Bool
    @Nullable public var lastProject: String?
    /// Board project filter (nil = All projects)
    @Nullable public var boardProject: String?
    @Nullable public var activeServer: String?
    /// Prefs schema version. 2: hideChildren defaults to hidden (older blobs saved false as a side effect).
    public var version: Int

    public init(
        theme: ThemePreference, lightTheme: String, darkTheme: String, hideChildren: Bool,
        lastProject: String? = nil, boardProject: String? = nil, activeServer: String? = nil, version: Int
    ) {
        self.theme = theme
        self.lightTheme = lightTheme
        self.darkTheme = darkTheme
        self.hideChildren = hideChildren
        self.lastProject = lastProject
        self.boardProject = boardProject
        self.activeServer = activeServer
        self.version = version
    }

    /// DEFAULT_PREFS
    public static let defaults = Prefs(
        theme: .system, lightTheme: Themes.defaultLightTheme, darkTheme: Themes.defaultDarkTheme,
        hideChildren: Conductor.hideChildrenDefault, lastProject: nil, boardProject: nil, activeServer: nil, version: 2
    )

    /// Stored prefs (possibly from an older build, or hand-damaged) → valid prefs. Only a JSON object
    /// contributes fields.
    public static func normalize(_ stored: JSONValue?) -> Prefs {
        let fields: [String: JSONValue] = if case let .object(o)? = stored { o } else { [:] }
        // A key that's present (even as null) replaces the default, as in `{ ...DEFAULT_PREFS, ...stored }`.
        func merged(_ key: String, _ fallback: JSONValue) -> JSONValue { fields[key] ?? fallback }

        var p = defaults
        // The defaults are nil, so a missing key, null and a non-string all come out nil.
        p.lastProject = fields["lastProject"]?.stringValue
        p.boardProject = fields["boardProject"]?.stringValue
        p.activeServer = fields["activeServer"]?.stringValue
        // Blobs from before v2 carried hideChildren: false whether or not the user chose it — reset once.
        let storedVersion = fields["version"]?.numberValue ?? 0
        if let hide = fields["hideChildren"]?.boolValue, storedVersion >= 2 { p.hideChildren = hide }
        p.version = defaults.version
        let choice = Themes.normalizeThemeChoice(.object([
            "appearance": merged("theme", .string(defaults.theme.rawValue)),
            "lightTheme": merged("lightTheme", .string(defaults.lightTheme)),
            "darkTheme": merged("darkTheme", .string(defaults.darkTheme)),
        ]))
        p.theme = choice.appearance
        p.lightTheme = choice.lightTheme
        p.darkTheme = choice.darkTheme
        return p
    }

    /// `normalize` for raw stored bytes; bytes that aren't JSON give the defaults.
    public static func normalize(data: Data?) -> Prefs {
        normalize(data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) })
    }
}
