import Foundation

// The file viewer's pure parts: where a file link in chat
// opens (route params for the viewer, and the params an OS-level harness://file/… URL opens),
// reading those params back, which lines of a long file to syntax highlight, and a unified patch
// as numbered rows.
//
// `fileRoute(forURL:)` returns the viewer's params as a struct and the SwiftUI navigation pushes it
// directly, so there's no route href to build or parse.

/// The ticket (or project) a piece of markdown belongs to, which a link's relative path resolves in.
public struct FileLinkContext: Codable, Equatable, Sendable {
    public var ticketKey: String?
    public var projectId: String?

    public init(ticketKey: String? = nil, projectId: String? = nil) {
        self.ticketKey = ticketKey
        self.projectId = projectId
    }
}

/// The viewer's params. Strings, because that's what a harness:// URL carries.
public struct FileRouteParams: Codable, Equatable, Hashable, Sendable {
    public var path: String
    public var ticket: String?
    public var project: String?
    public var start: String?
    public var end: String?

    public init(path: String, ticket: String? = nil, project: String? = nil, start: String? = nil, end: String? = nil) {
        self.path = path
        self.ticket = ticket
        self.project = project
        self.start = start
        self.end = end
    }
}

/// The folder a viewer path resolves in.
public enum FileRoot: Codable, Equatable, Hashable, Sendable {
    case ticket(key: String)
    case project(id: String)

    private enum CodingKeys: String, CodingKey { case kind, key, id }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "ticket": self = .ticket(key: try c.decode(String.self, forKey: .key))
        case "project": self = .project(id: try c.decode(String.self, forKey: .id))
        case let other: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown FileRoot kind \(other)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .ticket(key):
            try c.encode("ticket", forKey: .kind)
            try c.encode(key, forKey: .key)
        case let .project(id):
            try c.encode("project", forKey: .kind)
            try c.encode(id, forKey: .id)
        }
    }
}

public struct FileTarget: Codable, Equatable, Hashable, Sendable {
    @Nullable public var root: FileRoot?
    public var path: String
    /// 1-based, inclusive; lowerBound == upperBound for a single line. Encodes as `[start, end]`.
    @Nullable public var range: ClosedRange<Int>?

    public init(root: FileRoot?, path: String, range: ClosedRange<Int>?) {
        self.root = root
        self.path = path
        self.range = range
    }
}

public enum PatchRowKind: String, Codable, Sendable {
    case add, del, ctx, hunk
}

public struct PatchRow: Codable, Equatable, Sendable {
    public var kind: PatchRowKind
    /// Code without its +/-/space sign; a hunk row keeps its whole `@@ … @@` header
    public var text: String
    @Nullable public var oldLine: Int?
    @Nullable public var newLine: Int?
    /// The line's index in `Diff.parseDiff(patch).lines`, whose highlight colors it
    public var source: Int

    public init(kind: PatchRowKind, text: String, oldLine: Int?, newLine: Int?, source: Int) {
        self.kind = kind
        self.text = text
        self.oldLine = oldLine
        self.newLine = newLine
        self.source = source
    }
}

public enum FileViewer {
    /// Where a triage session's file links resolve (it has no folder of its own): the project of
    /// the ticket it dispatched, as on the desktop; that ticket's key when it isn't loaded (an
    /// older done ticket), which the service resolves to its folder; nothing when it dispatched
    /// nothing. `dispatchedProjectId` is the loaded ticket's projectId, nil when it isn't loaded.
    public static func triageLinkContext(dispatchedKey: String?, dispatchedProjectId: String?) -> FileLinkContext {
        if let dispatchedProjectId { return FileLinkContext(projectId: dispatchedProjectId) }
        if let dispatchedKey, !dispatchedKey.isEmpty { return FileLinkContext(ticketKey: dispatchedKey) }
        return FileLinkContext()
    }

    /// Where a file link opens: the link's own `?ticket=`/`?project=` wins, then the markdown's
    /// ticket, then its project. Nil when nothing names a root to resolve the path in.
    public static func fileRouteFor(_ link: FileLink, context ctx: FileLinkContext = FileLinkContext()) -> FileRouteParams? {
        var params = FileRouteParams(path: link.path)
        if let t = nonEmpty(link.ticketKey) {
            params.ticket = t
        } else if let p = nonEmpty(link.projectId) {
            params.project = p
        } else if let t = nonEmpty(ctx.ticketKey) {
            params.ticket = t
        } else if let p = nonEmpty(ctx.projectId) {
            params.project = p
        } else {
            return nil
        }
        if let s = link.startLine, s != 0 {
            params.start = String(s)
            if let e = link.endLine, e != 0 { params.end = String(e) }
        }
        return params
    }

    /// What a harness://file/… URL opened from outside the app (Safari, Notes, a QR code) shows:
    /// the viewer's params, or nil for anything else (left alone). A link without
    /// `?ticket=`/`?project=` still opens the viewer, which says it can't tell where.
    public static func fileRoute(forURL url: String) -> FileRouteParams? {
        let p = Array(FileLinks.prefix.unicodeScalars)
        let u = Array(url.unicodeScalars)
        // A case-insensitive match on the first 15 code units; only ASCII can lower-case into this
        // ASCII prefix, so an ASCII-only fold is exact.
        guard u.count >= p.count, zip(u, p).allSatisfy({ asciiLower($0) == $1 }) else { return nil }
        guard let link = FileLinks.parseFileLink(url) else { return nil }
        return fileRouteFor(link) ?? FileRouteParams(path: link.path)
    }

    /// The viewer's params, checked: a missing path is nil, and a bad or reversed range is fixed or
    /// dropped. Each param holds the query's values (only the first counts when a
    /// param repeats).
    public static func readFileParams(_ params: [String: [String]]) -> FileTarget? {
        func one(_ k: String) -> String? { nonEmpty(params[k]?.first) }
        guard let path = one("path") else { return nil }
        let root: FileRoot? = one("ticket").map { .ticket(key: $0) } ?? one("project").map { .project(id: $0) }
        var range: ClosedRange<Int>?
        if let start = lineNumber(one("start")) {
            if let end = lineNumber(one("end")) {
                range = min(start, end)...max(start, end)
            } else {
                range = start...start
            }
        }
        return FileTarget(root: root, path: path, range: range)
    }

    /// `readFileParams` for params this app built itself.
    public static func readFileParams(_ route: FileRouteParams) -> FileTarget? {
        var dict: [String: [String]] = ["path": [route.path]]
        if let v = route.ticket { dict["ticket"] = [v] }
        if let v = route.project { dict["project"] = [v] }
        if let v = route.start { dict["start"] = [v] }
        if let v = route.end { dict["end"] = [v] }
        return readFileParams(dict)
    }

    /// A file's lines as the viewer lists them: a trailing newline doesn't add an empty last line.
    public static func fileLines(_ contents: String) -> [String] {
        var lines = Code.splitLines(Code.normalizeCRLF(contents))
        if lines.count > 1 && lines[lines.count - 1].isEmpty { lines.removeLast() }
        return lines
    }

    /// The row to open at for a range starting on `start` (1-based): a few lines above it for context.
    public static func initialScrollIndex(start: Int?, total: Int, context: Int = 3) -> Int {
        guard let start, start != 0, total > 0 else { return 0 }
        return max(0, min(total - 1, start - 1 - context))
    }

    /// Which lines of a long file to syntax highlight: tokenizing is expensive and a highlighter
    /// caps a block's size, so a big file is colored a window at a time. The window grows from
    /// `center` (0-based) one line either way, alternately, while its text (newlines included)
    /// fits in `maxChars`; a line that alone is over budget still makes a window of one.
    public static func highlightWindow(lengths: [Int], center: Int, maxChars: Int) -> Range<Int> {
        let n = lengths.count
        if n == 0 { return 0..<0 }
        func size(_ i: Int) -> Int { lengths[i] + 1 }
        let mid = max(0, min(n - 1, center))
        var from = mid
        var to = mid + 1
        var used = size(mid)
        var grew = true
        while grew {
            grew = false
            if to < n && used + size(to) <= maxChars {
                used += size(to)
                to += 1
                grew = true
            }
            if from > 0 && used + size(from - 1) <= maxChars {
                from -= 1
                used += size(from)
                grew = true
            }
        }
        return from..<to
    }

    /// A one-file unified patch (GET …/file/diff) as rows to draw: hunk headers and code lines,
    /// each code line numbered on the side(s) it's on. File headers (`diff --git`, `index`,
    /// `---`/`+++`) and `\ No newline at end of file` markers are left out; so is everything when
    /// the patch has no hunk (a binary change).
    ///
    /// The sign is dropped as one scalar (which matters only for a hand-written line that starts
    /// with an astral character instead of a sign). Line numbers past Int.max saturate.
    public static func patchRows(_ patch: String) -> [PatchRow] {
        if patch.isEmpty { return [] }
        var rows: [PatchRow] = []
        var oldLine = 0
        var newLine = 0
        let lines = Diff.parseDiff(patch).lines
        for (source, l) in lines.enumerated() {
            // The patch's final newline leaves an empty last line; it isn't a context line.
            if l.kind == .meta || (l.text.isEmpty && source == lines.count - 1) { continue }
            if l.kind == .hunk {
                if let m = hunkStarts(l.text) {
                    oldLine = m.old
                    newLine = m.new
                }
                rows.append(PatchRow(kind: .hunk, text: l.text, oldLine: nil, newLine: nil, source: source))
                continue
            }
            // Lines before the first hunk (none in git's output) aren't code.
            if rows.isEmpty { continue }
            let text = String(String.UnicodeScalarView(l.text.unicodeScalars.dropFirst()))
            switch l.kind {
            case .add:
                rows.append(PatchRow(kind: .add, text: text, oldLine: nil, newLine: newLine, source: source))
                newLine = bump(newLine)
            case .del:
                rows.append(PatchRow(kind: .del, text: text, oldLine: oldLine, newLine: nil, source: source))
                oldLine = bump(oldLine)
            default:
                rows.append(PatchRow(kind: .ctx, text: text, oldLine: oldLine, newLine: newLine, source: source))
                oldLine = bump(oldLine)
                newLine = bump(newLine)
            }
        }
        return rows
    }

    /// "1.2 KB" style size for the header. Under 10 of a unit it keeps one decimal the way JS's
    /// `toFixed(1)` does (ties round up, on the exact binary value), so 3 MB reads "3.0 MB".
    public static func formatSize(_ bytes: Double) -> String {
        if bytes < 1024 { return "\(JSCompat.string(bytes)) B" }
        let units = ["KB", "MB", "GB"]
        var v = bytes / 1024
        var u = 0
        while v >= 1024 && u < units.count - 1 {
            v /= 1024
            u += 1
        }
        return "\(v < 10 ? toFixed1(v) : JSCompat.string(JSCompat.round(v))) \(units[u])"
    }

    // MARK: - Helpers

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    private static func asciiLower(_ c: Unicode.Scalar) -> Unicode.Scalar {
        (c.value >= 0x41 && c.value <= 0x5A) ? Unicode.Scalar(c.value + 0x20)! : c
    }

    private static func bump(_ n: Int) -> Int { n == Int.max ? n : n + 1 }

    private static func toInt(_ d: Double) -> Int { d >= 9.2e18 ? Int.max : Int(d) }

    /// `/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/`'s starts.
    private static func hunkStarts(_ line: String) -> (old: Int, new: Int)? {
        let s = Array(line.unicodeScalars)
        var p = 0
        func lit(_ t: String) -> Bool {
            for c in t.unicodeScalars {
                guard p < s.count, s[p] == c else { return false }
                p += 1
            }
            return true
        }
        func digits() -> Double? {
            let from = p
            while p < s.count && Code.isASCIIDigit(s[p]) { p += 1 }
            return p > from ? Double(String(String.UnicodeScalarView(s[from..<p])))! : nil
        }
        func optCount() -> Bool {
            guard p < s.count, s[p] == "," else { return true }
            p += 1
            return digits() != nil
        }
        guard lit("@@ -"), let old = digits(), optCount(), lit(" +"), let new = digits(), optCount(), lit(" @@") else { return nil }
        return (toInt(old), toInt(new))
    }

    /// `Number(v)` when it's a whole number ≥ 1, else nil. A whole number past Int.max (JS keeps
    /// it as an inexact Double) is nil too.
    private static func lineNumber(_ v: String?) -> Int? {
        guard let v else { return nil }
        let n = jsNumber(v)
        guard n.isFinite, n == n.rounded(.towardZero), n >= 1, n < 9.2e18 else { return nil }
        return Int(n)
    }

    /// JavaScript's `Number(string)` (StringToNumber): trimmed JS whitespace; empty is 0;
    /// `0x`/`0o`/`0b` integers (unsigned); otherwise an optionally signed decimal literal or
    /// `Infinity`. Anything else is NaN (no `inf`, `nan`, hex floats or digit separators).
    private static func jsNumber(_ raw: String) -> Double {
        let s = Array(JSCompat.trim(raw).unicodeScalars)
        if s.isEmpty { return 0 }
        if s.count > 2, s[0] == "0" {
            let radix: Int? = switch s[1] {
            case "x", "X": 16
            case "o", "O": 8
            case "b", "B": 2
            default: nil
            }
            if let radix {
                var value = 0.0
                for c in s[2...] {
                    guard let d = Int(String(c), radix: radix) else { return .nan }
                    value = value * Double(radix) + Double(d)
                }
                return value
            }
        }
        var p = 0
        var negative = false
        if s[p] == "+" || s[p] == "-" {
            negative = s[p] == "-"
            p += 1
        }
        if Array(s[p...]) == Array("Infinity".unicodeScalars) { return negative ? -.infinity : .infinity }
        let start = p
        var intDigits = 0
        while p < s.count && Code.isASCIIDigit(s[p]) { p += 1; intDigits += 1 }
        var fracDigits = 0
        if p < s.count && s[p] == "." {
            p += 1
            while p < s.count && Code.isASCIIDigit(s[p]) { p += 1; fracDigits += 1 }
        }
        guard intDigits + fracDigits > 0 else { return .nan }
        if p < s.count && (s[p] == "e" || s[p] == "E") {
            p += 1
            if p < s.count && (s[p] == "+" || s[p] == "-") { p += 1 }
            var expDigits = 0
            while p < s.count && Code.isASCIIDigit(s[p]) { p += 1; expDigits += 1 }
            guard expDigits > 0 else { return .nan }
        }
        guard p == s.count else { return .nan }
        // Validated as a plain decimal literal; Swift's parser agrees on those (and rounds correctly).
        var literal = String(String.UnicodeScalarView(s[start...]))
        if literal.hasPrefix(".") { literal = "0" + literal }
        guard let value = Double(literal) else { return .nan }
        return negative ? -value : value
    }

    /// `v.toFixed(1)` for 0 ≤ v < 100: the multiple of 0.1 nearest the exact value of `v`, ties
    /// to the larger (Swift's `%.1f` rounds ties to even instead, so 1.25 would read 1.2).
    private static func toFixed1(_ v: Double) -> String {
        var f = (v * 10).rounded(.down)
        // fma gives v·10 − f exactly: v < 10, so the fraction needs fewer than 53 bits.
        var r = (-f).addingProduct(v, 10)
        if r < 0 {
            f -= 1
            r += 1
        }
        let n = Int(r >= 0.5 ? f + 1 : f)
        return "\(n / 10).\(n % 10)"
    }
}
