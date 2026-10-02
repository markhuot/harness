import Foundation

// Port of shared/src/projectColors.ts. A project's key badge (the "HAR" chip in the sidebar, on
// cards, in headers) takes the project's color. A project stores one of the preset ids, a custom
// "#rrggbb", or null for the theme's accent. Each theme derives a readable badge from the swatch
// (ProjectKeyColors.for). The presets come from Resources/themes.json (PROJECT_COLORS).

public struct ProjectColor: Codable, Hashable, Sendable, Identifiable {
    /// Preset id, what's stored ("red").
    public var id: String
    /// Display name ("Red").
    public var name: String
    /// The swatch, "#rrggbb".
    public var hex: String

    public init(id: String, name: String, hex: String) {
        self.id = id
        self.name = name
        self.hex = hex
    }
}

/// `normalizeProjectColor`'s result: TS returns a string, null (none), or undefined (refused).
public enum NormalizedProjectColor: Hashable, Sendable {
    /// No color: the theme's accent badge.
    case none
    /// A preset id or a lower-case "#rrggbb".
    case color(String)
    /// Not a color; callers refuse it.
    case invalid

    /// The stored form (`string | null`), or nil for `.invalid` as well as `.none`.
    public var stored: String? {
        if case let .color(c) = self { return c }
        return nil
    }
}

public enum ProjectColors {
    /// The presets in swatch order (PROJECT_COLORS).
    public static let presets: [ProjectColor] = ThemesResource.bundled.PROJECT_COLORS

    private static let byId: [String: ProjectColor] = Dictionary(presets.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

    public static func preset(_ id: String) -> ProjectColor? { byId[id] }

    /// `isProjectColorId`: exactly a preset id (case-sensitive, no trimming).
    public static func isProjectColorId(_ v: String?) -> Bool {
        v.map { byId[$0] != nil } ?? false
    }

    public static func isProjectColorId(_ v: JSONValue?) -> Bool {
        isProjectColorId(v?.stringValue)
    }

    /// `normalizeProjectColor` for a JSON value: null → none, a non-string → invalid.
    public static func normalize(_ v: JSONValue?) -> NormalizedProjectColor {
        switch v {
        case .none, .some(.null): .none
        case let .some(.string(s)): normalize(s)
        default: .invalid
        }
    }

    /// `normalizeProjectColor`: a preset id, a lower-case "#rrggbb" ("#abc" expands), none for nil or
    /// "" (after trimming), and invalid for anything else.
    public static func normalize(_ v: String?) -> NormalizedProjectColor {
        guard let v else { return .none }
        let s = JSCompat.trim(v).lowercased()
        if s.isEmpty { return .none }
        if byId[s] != nil { return .color(s) }
        let u = Array(s.unicodeScalars)
        guard u.first == "#", u.dropFirst().allSatisfy({ CSSColor.hexValue($0) != nil }) else { return .invalid }
        if u.count == 7 { return .color(s) }
        if u.count == 4 { return .color("#" + u.dropFirst().map { "\($0)\($0)" }.joined()) }
        return .invalid
    }

    /// `projectColorHex`: the swatch hex for a stored color (preset or custom), nil for none or unusable.
    public static func hex(_ color: String?) -> String? {
        guard let n = normalize(color).stored else { return nil }
        return byId[n]?.hex ?? n
    }

    /// `projectColorName`: the preset's name, "Custom" for a hex, "Default" for none.
    public static func name(_ color: String?) -> String {
        guard let n = normalize(color).stored else { return "Default" }
        return byId[n]?.name ?? "Custom"
    }
}
