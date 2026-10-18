import Foundation
import Observation

// How a file (or the Spec tab) is shown: whether long lines wrap, and whether a markdown file shows its
// source or the rendered document. Wrap is remembered per file type; ViewMenu says which items the "…"
// menu offers. Port of shared/src/viewOptions.ts, tested against the same fixtures
// (shared/src/viewOptions.fixtures.json).

public enum ViewOptions {
    /// What a file's wrap setting is stored under: its lowercased extension (".html"), or its lowercased
    /// name when it has none ("makefile", ".env").
    public static func wrapKey(_ path: String) -> String {
        let name = (path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path).lowercased()
        guard let dot = name.lastIndex(of: ".") else { return name }
        let at = name.distance(from: name.startIndex, to: dot)
        return at > 0 && at < name.count - 1 ? String(name[dot...]) : name
    }

    /// Files that have a rendered view (the Spec tab always does).
    public static func hasRenderedView(_ path: String) -> Bool {
        let key = wrapKey(path)
        return key == ".md" || key == ".markdown"
    }

    /// The wrap key the Spec tab's source view uses: its text is markdown.
    public static let specWrapKey = ".md"

    /// A link in a rendered file, made relative to the file's own directory (`./b.md` in `docs/a.md` is
    /// `docs/b.md`). Links with a scheme, an anchor or a leading slash are left alone.
    public static func resolveFileRelative(_ path: String, _ url: String) -> String {
        if LinkRouting.hasScheme(url) || url.hasPrefix("/") || url.hasPrefix("#") { return url }
        guard let slash = path.lastIndex(of: "/") else { return url }
        return String(path[...slash]) + url
    }

    /// Stored wrap settings; anything unreadable is "no settings".
    public static func parseWrapPrefs(_ raw: String?) -> [String: Bool] {
        guard let raw, case let .object(o)? = try? JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)) else { return [:] }
        return o.compactMapValues { if case let .bool(b) = $0 { b } else { nil } }
    }

    public static func serializeWrapPrefs(_ prefs: [String: Bool]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: prefs, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}

/// What the "…" menu offers on a file or the Spec tab, and what's enabled.
public struct ViewMenu: Equatable, Sendable {
    /// The Source / Rendered items are offered
    public var view: Bool
    /// Source can be chosen (Show changes is a rendered view)
    public var sourceEnabled: Bool
    /// The Spec's Show changes item is offered
    public var showChanges: Bool
    /// The view on screen is rendered, whatever was chosen (Show changes forces it)
    public var rendered: Bool
    /// Wrap lines can be toggled: only the source wraps by choice (rendered text always wraps)
    public var wrapEnabled: Bool

    /// - Parameters:
    ///   - spec: the Spec tab (else a file at `path`)
    ///   - rendered: Rendered is chosen
    ///   - showChanges: Show changes is on (Spec only)
    ///   - canShowChanges: there is an earlier revision to compare with (Spec only)
    public init(spec: Bool, path: String? = nil, rendered: Bool, showChanges: Bool = false, canShowChanges: Bool = false) {
        view = spec || path.map(ViewOptions.hasRenderedView) == true
        let changes = spec && showChanges && canShowChanges
        self.rendered = view && (rendered || changes)
        sourceEnabled = !changes
        self.showChanges = spec && canShowChanges
        wrapEnabled = !self.rendered
    }
}

/// Which file types wrap their long lines, kept on this device (not synced: a phone and a wide Mac pane
/// want different things). Shared by the file viewer and the Spec tab.
@MainActor
@Observable
public final class WrapSettings {
    public nonisolated static let key = "harness.wrap"
    public static let shared = WrapSettings(UserDefaults.standard)

    private var prefs: [String: Bool]
    @ObservationIgnored private let store: any ChangesDefaults

    public init(_ store: any ChangesDefaults) {
        self.store = store
        prefs = ViewOptions.parseWrapPrefs(store.string(forKey: Self.key))
    }

    public func isWrapped(_ key: String) -> Bool { prefs[key] == true }

    /// A wrapped type is stored; an unwrapped one is dropped.
    public func set(_ key: String, _ wrap: Bool) {
        guard isWrapped(key) != wrap else { return }
        if wrap { prefs[key] = true } else { prefs[key] = nil }
        store.setString(ViewOptions.serializeWrapPrefs(prefs), forKey: Self.key)
    }
}
