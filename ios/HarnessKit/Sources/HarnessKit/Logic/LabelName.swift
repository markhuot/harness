import Foundation

/// Label names (DESIGN.md "Labels"): the rules shared/src/labels.ts holds, ported so a label typed
/// on the phone is accepted or refused exactly as the service would, and compared the same way.
/// Both read shared/src/labels.fixtures.json in their tests.
public enum LabelName {
    public static let maxLength = 40

    /// A label name as stored: trimmed with inner whitespace collapsed to single spaces. nil when it
    /// isn't usable: empty, over `maxLength`, or holding a `"` (which would break `label:"…"`).
    public static func normalize(_ raw: String) -> String? {
        let name = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if name.isEmpty || name.utf16.count > maxLength || name.contains("\"") { return nil }
        return name
    }

    /// What two names are compared by: case and diacritics ignored.
    public static func key(_ name: String) -> String {
        name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    /// The name list a ticket carries: normalized and de-duplicated by key (first spelling wins).
    public static func normalizeAll(_ names: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in names {
            guard let name = normalize(raw), seen.insert(key(name)).inserted else { continue }
            out.append(name)
        }
        return out
    }

    /// Why `raw` can't be a label, for the editor to show; nil when it's fine.
    public static func rejection(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "A label needs a name." }
        if trimmed.contains("\"") { return "A label name can't contain a double quote." }
        if normalize(raw) == nil { return "A label name can be at most \(maxLength) characters." }
        return nil
    }

    /// The ticket's labels with `raw` added; nil when the name is refused or the ticket already has it.
    public static func adding(_ raw: String, to labels: [String]) -> [String]? {
        guard let name = normalize(raw), !labels.contains(where: { key($0) == key(name) }) else { return nil }
        return labels + [name]
    }

    /// The ticket's labels without `name` (compared by key).
    public static func removing(_ name: String, from labels: [String]) -> [String] {
        labels.filter { key($0) != key(name) }
    }
}
