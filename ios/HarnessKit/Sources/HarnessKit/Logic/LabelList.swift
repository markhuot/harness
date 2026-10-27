import Foundation

/// The Labels section under Projects in the projects sheet and the iPad/Duo sidebar: the first
/// ten labels in collection order (most recently used first) whose server `count` is above zero,
/// then a "More" row that reveals ten more per tap until all show.
public enum LabelList {
    public static let pageSize = 10

    public struct Section: Equatable, Sendable {
        public var rows: [LabelInfo]
        /// How many more labels a tap on "More" would reveal (0 hides the row)
        public var hidden: Int
    }

    /// `pages` counts the taps on More so far: the section shows `(pages + 1) * pageSize` labels.
    public static func section(_ labels: [LabelInfo], pages: Int = 0) -> Section {
        let visible = labels.filter { $0.count > 0 }
        let shown = min(visible.count, (max(0, pages) + 1) * pageSize)
        return Section(rows: Array(visible.prefix(shown)), hidden: visible.count - shown)
    }

    /// The label named `name` (compared by key), for chips that only carry the name.
    public static func info(_ name: String, in labels: [LabelInfo]) -> LabelInfo? {
        let key = LabelName.key(name)
        return labels.first { LabelName.key($0.name) == key }
    }

    /// The color id a chip draws: the collection's, else the stable default for the name.
    public static func colorId(_ name: String, in labels: [LabelInfo]) -> String {
        info(name, in: labels)?.color ?? defaultColor(name)
    }

    /// The color a new label starts with: a stable pick from its name (FNV-1a over the key's UTF-8),
    /// so every client and a re-created label agree with shared/src/labels.ts.
    public static func defaultColor(_ name: String) -> String {
        var h: UInt32 = 0x811c9dc5
        for byte in LabelName.key(name).utf8 {
            h ^= UInt32(byte)
            h = h &* 0x01000193
        }
        let ids = ProjectColors.presets
        return ids[Int(h) % ids.count].id
    }

    /// Existing labels the editor offers for what's typed: a prefix of any word of the name,
    /// not already on the ticket.
    public static func suggestions(_ typed: String, labels: [LabelInfo], excluding: [String]) -> [LabelInfo] {
        let typedKey = LabelName.key(typed.trimmingCharacters(in: .whitespaces))
        let taken = Set(excluding.map(LabelName.key))
        return labels.filter { info in
            let key = LabelName.key(info.name)
            guard !taken.contains(key) else { return false }
            if typedKey.isEmpty { return true }
            return key.hasPrefix(typedKey) || key.split(separator: " ").contains { $0.hasPrefix(typedKey) }
        }
    }

    /// One row of a label picker: a label that exists, or the new name the typed text would create.
    public enum Option: Equatable, Sendable, Identifiable {
        case existing(LabelInfo)
        case create(String)

        public var id: String {
            switch self {
            case let .existing(info): "existing:\(info.name)"
            case let .create(name): "create:\(name)"
            }
        }

        public var name: String {
            switch self {
            case let .existing(info): info.name
            case let .create(name): name
            }
        }
    }

    /// The rows of a label picker for a ticket carrying `current`. Adding lists the labels it lacks
    /// that match the typed text (every one while nothing's typed; an exact match first), then
    /// Create for a valid name no label has yet. Removing lists the ticket's own labels that match.
    public static func options(_ typed: String, labels: [LabelInfo], current: [String], removing: Bool) -> [Option] {
        let trimmed = typed.trimmingCharacters(in: .whitespaces)
        let typedKey = LabelName.key(trimmed)
        if removing {
            return current.filter { typedKey.isEmpty || LabelName.key($0).contains(typedKey) }
                .map { name in .existing(info(name, in: labels) ?? LabelInfo(name: name, color: defaultColor(name), createdAt: 0, lastUsedAt: 0, count: 0)) }
        }
        let found = suggestions(typed, labels: labels, excluding: current)
        var rows: [Option] = (found.filter { LabelName.key($0.name) == typedKey } + found.filter { LabelName.key($0.name) != typedKey }).map { .existing($0) }
        if let name = LabelName.normalize(trimmed) {
            let key = LabelName.key(name)
            if !labels.contains(where: { LabelName.key($0.name) == key }) && !current.contains(where: { LabelName.key($0) == key }) {
                rows.append(.create(name))
            }
        }
        return rows
    }
}
