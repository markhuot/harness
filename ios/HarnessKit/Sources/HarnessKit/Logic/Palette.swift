import Foundation

// The command palette's pure parts, the phone's port of app/src/renderer/state/palette.ts: fuzzy
// ranking, the ">" / "#" / "@" prefixes, file queries (`path:12`, `path#L12-L20`) and the file
// recents. The views (Features/Palette) build the rows and draw them.
//
// Ranking is a case-insensitive subsequence match on the label, scored in tiers: the label starts
// with the query, then the query starts a word ("sess" in "New Session") or picks out word
// initials ("ns"), then it's a run inside a word, then scattered letters. Ties go to the more
// recently run item, then to the order the items came in. Highlight ranges are offsets in
// Characters of the label, so an accent or an emoji never splits.

/// Something the palette ranks by label.
public protocol PaletteRankable {
    var label: String { get }
    /// Other words it answers to (a project's key). A keyword match ranks below a label match of the
    /// same tier.
    var keywords: [String] { get }
    /// 0 is the one run most recently; nil is not recent.
    var recentRank: Int? { get }
}

public extension PaletteRankable {
    var keywords: [String] { [] }
    var recentRank: Int? { nil }
}

/// A ranked item: its index in the list ranked, and the Character ranges of its label that matched.
public struct PaletteMatch: Equatable, Sendable {
    public var index: Int
    public var ranges: [Range<Int>]
    public var score: Int
}

public enum PaletteRanker {
    private static let tierPrefix = 4
    private static let tierWord = 3
    private static let tierRun = 2
    private static let tierScattered = 1

    /// The items matching `query`, best first. An empty query keeps every item: the recent ones
    /// first (most recent first), then the rest in order.
    public static func rank<T: PaletteRankable>(_ query: String, _ items: [T]) -> [PaletteMatch] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let recency = { (i: Int) in items[i].recentRank ?? Int.max }
        if q.isEmpty {
            return items.indices
                .sorted { recency($0) != recency($1) ? recency($0) < recency($1) : $0 < $1 }
                .map { PaletteMatch(index: $0, ranges: [], score: 0) }
        }
        var scored: [PaletteMatch] = []
        for i in items.indices {
            if let m = match(q, items[i].label) {
                // Within a tier, fewer separate pieces read as a better match.
                scored.append(PaletteMatch(index: i, ranges: m.ranges, score: m.tier * 100 - min(m.ranges.count, 50)))
                continue
            }
            let kw = items[i].keywords.compactMap { match(q, $0)?.tier }
            if let best = kw.max() { scored.append(PaletteMatch(index: i, ranges: [], score: best * 100 - 50)) }
        }
        return scored.sorted {
            if $0.score != $1.score { return $0.score > $1.score }
            if recency($0.index) != recency($1.index) { return recency($0.index) < recency($1.index) }
            return $0.index < $1.index
        }
    }

    /// The best match of `q` (lower-cased, non-empty) in `text`, or nil.
    public static func match(_ q: String, _ text: String) -> (tier: Int, ranges: [Range<Int>])? {
        let chars = Array(text)
        let lower = chars.map { $0.lowercased() }
        let query = q.map { $0.lowercased() }
        func isWordChar(_ c: Character) -> Bool { c.isLetter || c.isNumber }
        func wordStart(_ i: Int) -> Bool {
            if i == 0 { return true }
            let prev = chars[i - 1], cur = chars[i]
            if !isWordChar(prev) { return isWordChar(cur) }
            return prev.lowercased() == String(prev) && cur.lowercased() != String(cur)
        }
        func find(_ needle: [String], from: Int = 0) -> Int? {
            guard !needle.isEmpty, lower.count >= needle.count, from <= lower.count - needle.count else { return nil }
            for i in from...(lower.count - needle.count) where Array(lower[i..<(i + needle.count)]) == needle { return i }
            return nil
        }
        if lower.starts(with: query) { return (tierPrefix, [0..<query.count]) }
        var at = find(query)
        while let i = at {
            if wordStart(i) { return (tierWord, [i..<(i + query.count)]) }
            at = find(query, from: i + 1)
        }
        // Spaces in the query are ignored from here on; initials: "ns" is New Session.
        let letters = query.filter { !$0.allSatisfy(\.isWhitespace) }
        guard !letters.isEmpty else { return nil }
        var initials: [Int] = []
        var i = 0
        while i < lower.count && initials.count < letters.count {
            if lower[i] == letters[initials.count] && wordStart(i) { initials.append(i) }
            i += 1
        }
        if initials.count == letters.count { return (tierWord, ranges(initials)) }
        if let run = find(query) { return (tierRun, [run..<(run + query.count)]) }
        var hits: [Int] = []
        i = 0
        while i < lower.count && hits.count < letters.count {
            if lower[i] == letters[hits.count] { hits.append(i) }
            i += 1
        }
        return hits.count == letters.count ? (tierScattered, ranges(hits)) : nil
    }

    /// Adjacent single-character matches merged into runs.
    private static func ranges(_ indices: [Int]) -> [Range<Int>] {
        var out: [Range<Int>] = []
        for i in indices {
            if let last = out.last, last.upperBound == i { out[out.count - 1] = last.lowerBound..<(i + 1) } else { out.append(i..<(i + 1)) }
        }
        return out
    }
}

/// What a leading character limits the palette to.
public enum PaletteMode: Equatable, Sendable {
    case all, commands, tickets, files
}

public struct PaletteQuery: Equatable, Sendable {
    public var mode: PaletteMode
    /// The query without its prefix.
    public var text: String

    /// ">" limits the palette to commands (and the Go to rows), "#" to tickets, "@" to files; the
    /// rest is the query. In ">" the ticket and file searches never run, however the rest reads.
    public static func parse(_ raw: String) -> PaletteQuery {
        let s = raw.drop { $0.isWhitespace }
        func rest(_ s: Substring) -> String { s.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines) }
        switch s.first {
        case ">": return PaletteQuery(mode: .commands, text: rest(s))
        case "#": return PaletteQuery(mode: .tickets, text: rest(s))
        case "@": return PaletteQuery(mode: .files, text: rest(s))
        default: return PaletteQuery(mode: .all, text: s.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// Whether this query asks the server for matching tickets.
    public var wantsTickets: Bool { mode == .all || mode == .tickets }
    public var wantsFiles: Bool { mode == .files }
    public var wantsCommands: Bool { mode == .all || mode == .commands }
}

/// A file query: the text to search for and the lines to open at.
public struct PaletteFileQuery: Equatable, Sendable {
    public var search: String
    public var startLine: Int?
    public var endLine: Int?

    /// Splits a trailing line or range off, as editors and agents write them: `path:12`, `path:12-20`,
    /// `path:12:3` (a column, dropped), `path#L12`, `path#L12-L20`, `path#L12-20`. The range is put
    /// in order and a one-line range is its start; line 0 isn't a line.
    public static func parse(_ q: String) -> PaletteFileQuery {
        let s = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let m = suffix.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              let head = Range(m.range(at: 1), in: s) else { return PaletteFileQuery(search: s) }
        func int(_ i: Int) -> Int? { Range(m.range(at: i), in: s).flatMap { Int(s[$0]) } }
        let search = s[head].trimmingCharacters(in: .whitespaces)
        guard var start = int(2) ?? int(4), start >= 1 else { return PaletteFileQuery(search: search) }
        var end = int(3) ?? int(5)
        if let e = end, e < start { end = start; start = e }
        return end != nil && end != start
            ? PaletteFileQuery(search: search, startLine: start, endLine: end)
            : PaletteFileQuery(search: search, startLine: start)
    }

    private static let suffix = try! NSRegularExpression(pattern: #"^(.*?)(?::(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)$"#)
}

/// The folder the file browser searches: a ticket's worktree (where its agent works) or a project's.
public enum PaletteFileRoot: Equatable, Hashable, Sendable {
    case ticket(String)
    case project(String)

    /// The focused ticket's, else the board's project; nil on All projects (or a group's board) with
    /// no ticket open, where there's no one folder to search.
    public static func pick(focusedTicket: String?, project: String?) -> PaletteFileRoot? {
        if let focusedTicket { return .ticket(focusedTicket) }
        return project.map { .project($0) }
    }

    fileprivate var prefix: String {
        switch self {
        case let .ticket(k): "file:t:\(k)\u{0}"
        case let .project(p): "file:p:\(p)\u{0}"
        }
    }

    /// A file's id in the recents: its root plus its path.
    public func fileID(_ path: String) -> String { prefix + path }
}

/// Files opened from the palette, every root's in one list (30), most recent first.
public enum PaletteRecents {
    public static let filesKey = "harness.palette.recentFiles"
    public static let filesMax = 30

    /// Item ids, most recent first. Missing or corrupt storage is an empty list.
    public static func read(_ defaults: UserDefaults = .standard, key: String = filesKey, max: Int = filesMax) -> [String] {
        var seen = Set<String>()
        return (defaults.stringArray(forKey: key) ?? []).filter { seen.insert($0).inserted }.prefix(max).map { $0 }
    }

    /// `id` at the front (once), keeping the last `max`; returns the new list.
    @discardableResult
    public static func push(_ id: String, _ defaults: UserDefaults = .standard, key: String = filesKey, max: Int = filesMax) -> [String] {
        let next = Array(([id] + read(defaults, key: key, max: max).filter { $0 != id }).prefix(max))
        defaults.set(next, forKey: key)
        return next
    }

    /// The paths among `recents` that belong to `root`, most recent first.
    public static func paths(_ recents: [String], root: PaletteFileRoot) -> [String] {
        let prefix = root.prefix
        return recents.filter { $0.hasPrefix(prefix) && $0.count > prefix.count }.map { String($0.dropFirst(prefix.count)) }
    }
}
