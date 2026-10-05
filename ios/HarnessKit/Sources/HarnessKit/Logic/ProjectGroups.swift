import Foundation

// Port of shared/src/projectGroups.ts and shared/src/state/groups.ts. A project group is a
// human-readable name ("Work", "Personal") several projects share. Each group gets its own board,
// like All projects but with only its projects (Paging.groupScope). A project is in at most one
// group; the name is all there is to a group, so it exists while a project carries it.

/// A row of project settings' Group picker for what's typed (`groupRows`).
public enum GroupRow: Equatable, Sendable {
    /// Leave the project out of every group
    case none
    case group(String)
    /// The typed name, which no group has yet
    case new(String)
    /// A typed name the service would refuse (not pickable)
    case invalid

    /// What picking the row sets (nil: no group, or not pickable).
    public var value: String? {
        switch self {
        case .none, .invalid: nil
        case let .group(g), let .new(g): g
        }
    }

    public var label: String {
        switch self {
        case .none: ProjectGroups.noGroupLabel
        case let .group(g): g
        case let .new(g): "New group \"\(g)\""
        case .invalid: "Group names are at most \(ProjectGroups.maxLength) characters"
        }
    }

    /// groupRowIds: No group is "", a group (or new name) its name, invalid rows have none.
    public var id: String? {
        switch self {
        case .invalid: nil
        default: value ?? ""
        }
    }
}

public enum ProjectGroups {
    /// The longest group name the service stores (PROJECT_GROUP_MAX), in UTF-16 code units.
    public static let maxLength = 60
    public static let noGroupLabel = "No group"

    /// `normalizeProjectGroup` for a string: trimmed, inner runs of whitespace made one space.
    /// `.null` for blank (no group), `.absent` when it's longer than `maxLength` (undefined in TS).
    public static func normalize(_ value: String?) -> Patch<String> {
        guard let value else { return .null }
        var out = String.UnicodeScalarView()
        var space = false
        for scalar in JSCompat.trim(value).unicodeScalars {
            if JSCompat.isWhitespace(scalar) {
                if !space { out.append(" ") }
                space = true
            } else {
                out.append(scalar)
                space = false
            }
        }
        let name = String(out)
        if name.isEmpty { return .null }
        return name.utf16.count > maxLength ? .absent : .value(name)
    }

    /// Group names compare without case (accents still count), so "work" finds "Work".
    public static func same(_ a: String, _ b: String) -> Bool {
        a.compare(b, options: [.caseInsensitive], range: nil, locale: Locale(identifier: "en_US")) == .orderedSame
    }

    /// The spelling a new group name should take: an existing group's when one matches it without
    /// case, else the name as typed.
    public static func canonical(_ name: String, existing: some Sequence<String>) -> String {
        existing.first { same($0, name) } ?? name
    }

    /// Every group the projects carry, once each, alphabetically without case or accents (as the
    /// sidebar lists them), then by code unit.
    public static func list(_ projects: some Sequence<Project>) -> [String] {
        var out: [String] = []
        for p in projects { if let g = p.group, !g.isEmpty, !out.contains(g) { out.append(g) } }
        return out.sorted { a, b in
            let c = a.compare(b, options: [.caseInsensitive, .diacriticInsensitive], range: nil, locale: Locale(identifier: "en_US"))
            return c != .orderedSame ? c == .orderedAscending : JSString.less(a, b)
        }
    }

    /// Whether some project carries the group (its board exists).
    public static func exists(_ group: String, in projects: some Sequence<Project>) -> Bool {
        projects.contains { $0.group == group }
    }

    /// `groupRows`: No group first (while nothing is typed, or every typed word is in its label),
    /// then the existing groups whose name has every typed word, then the typed name as a new group
    /// when no group has it in any case (typing "work" picks "Work" instead).
    public static func rows(_ groups: [String], query: String) -> [GroupRow] {
        let words = JSString.lower(query).split(whereSeparator: { $0.unicodeScalars.allSatisfy(JSCompat.isWhitespace) }).map(String.init)
        var rows: [GroupRow] = []
        if words.allSatisfy({ JSString.includes(JSString.lower(noGroupLabel), $0) }) { rows.append(.none) }
        for g in groups where words.allSatisfy({ JSString.includes(JSString.lower(g), $0) }) { rows.append(.group(g)) }
        switch normalize(query) {
        case .absent: rows.append(.invalid)
        case let .value(name) where !groups.contains(where: { same($0, name) }): rows.append(.new(name))
        default: break
        }
        return rows
    }

    /// The row Return in the picker's field picks: the typed name as a new group, else the group it
    /// names in any case. Nothing for an empty field, an invalid name, or a name that only
    /// partly matches.
    public static func submitRow(_ rows: [GroupRow], query: String) -> GroupRow? {
        if let new = rows.first(where: { if case .new = $0 { true } else { false } }) { return new }
        guard case let .value(name) = normalize(query) else { return nil }
        return rows.first { if case let .group(g) = $0 { same(g, name) } else { false } }
    }
}
