import Foundation

// Port of shared/src/projectGroups.ts and shared/src/state/groups.ts. A project group is a
// human-readable name ("Work", "Personal") several projects share. Each group gets its own board,
// like All projects but with only its projects (Paging.groupScope). A project is in at most one
// group. A group has an id that never changes and a name that can; everything that refers to a
// group (a board's scope, a saved filter, a project's membership) uses the id. The apps only learn
// groups from the projects that carry them, so a group with no project isn't listed.

/// A project group as the apps list it: its id and the name it shows under.
public struct ProjectGroup: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// A group as the service sends it (GET /groups, PATCH /groups/:id).
public struct GroupRecord: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var createdAt: Timestamp

    public init(id: String, name: String, createdAt: Timestamp) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
    }
}

/// What picking a row sets on the project: no group, an existing group by id, or a name the
/// service finds or makes a group for.
public enum GroupPick: Equatable, Sendable {
    case clear
    case group(String)
    case named(String)
}

/// A row of project settings' Group picker for what's typed (`groupRows`).
public enum GroupRow: Equatable, Sendable {
    /// Leave the project out of every group
    case none
    case group(ProjectGroup)
    /// The typed name, which no group has yet
    case new(String)
    /// A typed name the service would refuse (not pickable)
    case invalid

    /// What picking the row sets (nil: not pickable).
    public var pick: GroupPick? {
        switch self {
        case .invalid: nil
        case .none: .clear
        case let .group(g): .group(g.id)
        case let .new(name): .named(name)
        }
    }

    public var label: String {
        switch self {
        case .none: ProjectGroups.noGroupLabel
        case let .group(g): g.name
        case let .new(g): "New group \"\(g)\""
        case .invalid: "Group names are at most \(ProjectGroups.maxLength) characters"
        }
    }

    /// groupRowId: No group is "", a group its id, a new name "new:<name>" (so a name can't be taken
    /// for an id). Invalid rows have none.
    public var id: String? {
        switch self {
        case .invalid: nil
        case .none: ""
        case let .group(g): g.id
        case let .new(name): "new:\(name)"
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

    /// Every group the projects carry, once each by id, alphabetically without case or accents (as
    /// the sidebar lists them), then by code unit, then by id.
    public static func list(_ projects: some Sequence<Project>) -> [ProjectGroup] {
        var out: [ProjectGroup] = []
        for p in projects {
            if let id = p.groupId, let name = p.group, !name.isEmpty, !out.contains(where: { $0.id == id }) { out.append(ProjectGroup(id: id, name: name)) }
        }
        return out.sorted { a, b in
            let c = a.name.compare(b.name, options: [.caseInsensitive, .diacriticInsensitive], range: nil, locale: Locale(identifier: "en_US"))
            if c != .orderedSame { return c == .orderedAscending }
            return a.name != b.name ? JSString.less(a.name, b.name) : JSString.less(a.id, b.id)
        }
    }

    /// Whether some project is in the group (its board exists).
    public static func exists(_ groupId: String, in projects: some Sequence<Project>) -> Bool {
        projects.contains { $0.groupId == groupId }
    }

    /// `resolveGroupKey`: the id a saved group reference means. `key` itself when a group has that
    /// id, else the group named `key` (any case): scopes saved before groups had ids hold the name.
    /// nil when neither matches.
    public static func resolve(_ key: String, in groups: [ProjectGroup]) -> String? {
        if let g = groups.first(where: { $0.id == key }) { return g.id }
        return groups.first { same($0.name, key) }?.id
    }

    /// `groupMatchRank`: how well a group's name matches the typed text (lower-cased, whitespace
    /// collapsed), best first: 0 the same name in any case, 1 the name starts with it, 2 a word of
    /// the name does (after a code unit that isn't a letter or digit), 3 it's elsewhere or only its
    /// words are. On UTF-16 code units, as in JavaScript.
    public static func matchRank(_ group: String, typed: String) -> Int {
        if same(group, typed) { return 0 }
        let h = Array(JSString.lower(group).utf16), n = Array(typed.utf16)
        if h.starts(with: n) { return 1 }
        if !n.isEmpty, n.count <= h.count {
            for i in stride(from: 1, through: h.count - n.count, by: 1) where Array(h[i..<(i + n.count)]) == n {
                if !isLetterOrDigit(h[i - 1]) { return 2 }
            }
        }
        return 3
    }

    /// `/[\p{L}\p{N}]/u` on one UTF-16 code unit (a lone surrogate is neither).
    private static func isLetterOrDigit(_ unit: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    /// `groupRows`. Nothing typed: No group, then every group. Otherwise the groups whose name has
    /// every typed word, best match first (`matchRank`, alphabetical within a rank), then No group
    /// when every typed word is in its label, then the typed name as a new group when no group has
    /// it in any case (typing "work" picks "Work" instead). The first row is the best pick.
    public static func rows(_ groups: [ProjectGroup], query: String) -> [GroupRow] {
        let words = JSString.lower(query).split(whereSeparator: { $0.unicodeScalars.allSatisfy(JSCompat.isWhitespace) }).map(String.init)
        let typed = words.joined(separator: " ")
        let matches = groups.enumerated()
            .filter { _, g in words.allSatisfy { JSString.includes(JSString.lower(g.name), $0) } }
            .map { i, g in (i: i, g: g, rank: matchRank(g.name, typed: typed)) }
            .sorted { $0.rank != $1.rank ? $0.rank < $1.rank : $0.i < $1.i }
            .map { GroupRow.group($0.g) }
        if typed.isEmpty { return [.none] + matches }
        var rows = matches
        if words.allSatisfy({ JSString.includes(JSString.lower(noGroupLabel), $0) }) { rows.append(.none) }
        switch normalize(query) {
        case .absent: rows.append(.invalid)
        case let .value(name) where !groups.contains(where: { same($0.name, name) }): rows.append(.new(name))
        default: break
        }
        return rows
    }

    /// The row Return in the picker's field picks: the first pickable row, which is the best match
    /// (an existing group the typed text completes to, else the typed name as a new group), as Enter
    /// does on the Mac. Nothing for an empty field.
    public static func submitRow(_ rows: [GroupRow], query: String) -> GroupRow? {
        if case .null = normalize(query) { return nil }
        return rows.first { $0 != .invalid }
    }
}
