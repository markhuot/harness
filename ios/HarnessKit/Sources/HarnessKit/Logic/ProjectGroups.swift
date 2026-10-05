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
    public static func rows(_ groups: [String], query: String) -> [GroupRow] {
        let words = JSString.lower(query).split(whereSeparator: { $0.unicodeScalars.allSatisfy(JSCompat.isWhitespace) }).map(String.init)
        let typed = words.joined(separator: " ")
        let matches = groups.enumerated()
            .filter { _, g in words.allSatisfy { JSString.includes(JSString.lower(g), $0) } }
            .map { i, g in (i: i, g: g, rank: matchRank(g, typed: typed)) }
            .sorted { $0.rank != $1.rank ? $0.rank < $1.rank : $0.i < $1.i }
            .map { GroupRow.group($0.g) }
        if typed.isEmpty { return [.none] + matches }
        var rows = matches
        if words.allSatisfy({ JSString.includes(JSString.lower(noGroupLabel), $0) }) { rows.append(.none) }
        switch normalize(query) {
        case .absent: rows.append(.invalid)
        case let .value(name) where !groups.contains(where: { same($0, name) }): rows.append(.new(name))
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
