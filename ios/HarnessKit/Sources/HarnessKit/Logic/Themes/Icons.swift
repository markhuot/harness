import Foundation

/// The shared icon set (shared/src/state/icons.ts): 24×24 stroke paths drawn with round caps and
/// joins and no fill. Plugin manifests name icons from this set. From Resources/themes.json.
public enum Icons {
    /// Icon names in declaration order.
    public static let names: [String] = ThemesResource.bundled.ICON_NAMES
    /// Icon name → SVG path data.
    public static let paths: [String: String] = ThemesResource.bundled.ICON_PATHS

    public static func path(_ name: String) -> String? { paths[name] }

    /// `isIconName`.
    public static func isIconName(_ name: String) -> Bool { paths[name] != nil }
}
