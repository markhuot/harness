import Foundation

// Port of shared/src/fileLinks.ts. Links to project files in chat messages: agents write
// `harness://file/<path>[#L<start>[-L<end>]]` (path relative to the ticket's root), with
// `?ticket=KEY` or `?project=<id>` pointing it at another context. Plain markdown links without a
// scheme (`src/a.ts#L10`, `./b.ts`, `/Users/…/c.ts`) count too.
//
// Everything works on Unicode scalars, not Characters: JS splits and searches code units, and a
// Swift Character can swallow a `/`, `#` or `?` into a grapheme with a following combining mark.

/// The file a link points at.
public struct FileLink: Codable, Equatable, Sendable {
    /// Normalized path: no `./`, no `..`, no leading slash unless absolute.
    public var path: String
    public var startLine: Int?
    public var endLine: Int?
    public var ticketKey: String?
    public var projectId: String?
    /// The link named an absolute path; the UI resolves it only when it's inside the root.
    public var absolute: Bool

    public init(path: String, startLine: Int? = nil, endLine: Int? = nil, ticketKey: String? = nil, projectId: String? = nil, absolute: Bool = false) {
        self.path = path
        self.startLine = startLine
        self.endLine = endLine
        self.ticketKey = ticketKey
        self.projectId = projectId
        self.absolute = absolute
    }

    private enum CodingKeys: String, CodingKey { case path, startLine, endLine, ticketKey, projectId, absolute }

    /// `absolute` may be missing (formatFileLink's input type makes it optional); it defaults to false.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        startLine = try c.decodeIfPresent(Int.self, forKey: .startLine)
        endLine = try c.decodeIfPresent(Int.self, forKey: .endLine)
        ticketKey = try c.decodeIfPresent(String.self, forKey: .ticketKey)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        absolute = try c.decodeIfPresent(Bool.self, forKey: .absolute) ?? false
    }
}

public enum FileLinks {
    public static let prefix = "harness://file/"

    private typealias Scalars = [Unicode.Scalar]

    /// The file a link points at, or nil when it isn't a file link (another scheme, an anchor,
    /// garbage, or a path that climbs out of the root). A line number past Int.max drops the range,
    /// where JS would keep an inexact Double.
    public static func parseFileLink(_ url: String) -> FileLink? {
        let u = Array(url.unicodeScalars)
        var rest: Scalars
        let p = Array(prefix.unicodeScalars)
        // JS lower-cases the first 15 code units and compares; only ASCII can lower-case into this
        // ASCII prefix, so an ASCII-only fold is exact.
        if u.count >= p.count, zip(u, p).allSatisfy({ asciiLower($0) == $1 }) {
            rest = Array(u[p.count...])
        } else if hasScheme(u) || u.starts(with: ["/", "/"]) || u.first == "#" {
            return nil
        } else {
            rest = u
        }

        var hash: Scalars = []
        if let at = rest.firstIndex(of: "#") {
            hash = Array(rest[(at + 1)...])
            rest = Array(rest[..<at])
        }
        var query: Scalars = []
        if let at = rest.firstIndex(of: "?") {
            query = Array(rest[(at + 1)...])
            rest = Array(rest[..<at])
        }

        guard let decodedString = URIComponent.decode(string(rest)) else { return nil }
        let decoded = Array(decodedString.unicodeScalars)
        if decoded.contains("\0") { return nil }
        let absolute = decoded.first == "/"
        var parts: [Scalars] = []
        for seg in decoded.split(separator: "/", omittingEmptySubsequences: false) {
            if seg.isEmpty || seg.elementsEqual(["."]) { continue }
            if seg.elementsEqual([".", "."]) {
                if parts.isEmpty { return nil }
                parts.removeLast()
            } else {
                parts.append(Array(seg))
            }
        }
        if parts.isEmpty { return nil }

        var link = FileLink(path: (absolute ? "/" : "") + parts.map(string).joined(separator: "/"), absolute: absolute)
        if let (first, second) = lineRange(hash) {
            var start = first
            var end = second
            if let e = end, e < start { (start, end) = (e, start) }
            if start >= 1 {
                link.startLine = start
                if let e = end, e != start { link.endLine = e }
            }
        }
        // Parsed by hand, like the TS (React Native's URLSearchParams is incomplete).
        if !query.isEmpty {
            for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
                let eq = pair.firstIndex(of: "=")
                let key = eq.map { Array(pair[..<$0]) } ?? Array(pair)
                let raw = eq.map { Array(pair[pair.index(after: $0)...]) } ?? []
                let spaced = raw.map { $0 == "+" ? " " : $0 }
                guard let value = URIComponent.decode(string(spaced)), !value.isEmpty else { continue }
                if key.elementsEqual("ticket".unicodeScalars) { link.ticketKey = value }
                else if key.elementsEqual("project".unicodeScalars) { link.projectId = value }
            }
        }
        return link
    }

    /// The canonical `harness://file/…` URL for a file (and optional line range and context).
    /// `absolute` is ignored: a leading `/` in `path` is what makes the link absolute.
    public static func formatFileLink(_ link: FileLink) -> String {
        let lead = link.path.unicodeScalars.first == "/" ? "/" : ""
        let path = segments(link.path).map { URIComponent.encode($0) }.joined(separator: "/")
        var params: [String] = []
        if let t = link.ticketKey, !t.isEmpty { params.append("ticket=\(URIComponent.encode(t))") }
        if let p = link.projectId, !p.isEmpty { params.append("project=\(URIComponent.encode(p))") }
        let query = params.isEmpty ? "" : "?" + params.joined(separator: "&")
        var hash = ""
        if let s = link.startLine, s != 0 {
            let (start, end): (Int, Int?) = if let e = link.endLine, e != 0, e < s { (e, s) } else { (s, link.endLine) }
            if let end, end != 0, end != start { hash = "#L\(start)-L\(end)" } else { hash = "#L\(start)" }
        }
        return "\(prefix)\(lead)\(path)\(query)\(hash)"
    }

    /// A short label for a file link: `app.ts`, `app.ts:102`, `app.ts:102-115`.
    public static func lineRangeLabel(path: String, startLine: Int?, endLine: Int?) -> String {
        let name = segments(path).last ?? path
        guard let start = startLine, start != 0 else { return name }
        if let end = endLine, end != 0 { return "\(name):\(start)-\(end)" }
        return "\(name):\(start)"
    }

    public static func lineRangeLabel(_ link: FileLink) -> String {
        lineRangeLabel(path: link.path, startLine: link.startLine, endLine: link.endLine)
    }

    // MARK: Helpers

    /// `/^L(\d+)(?:-L?(\d+))?$/` with ASCII digits (JS `\d` without the `u` flag).
    private static func lineRange(_ h: Scalars) -> (Int, Int?)? {
        guard h.first == "L" else { return nil }
        var i = 1
        func digitRun() -> String? {
            let from = i
            while i < h.count, ("0"..."9").contains(h[i]) { i += 1 }
            return i > from ? string(h[from..<i]) : nil
        }
        guard let first = digitRun() else { return nil }
        var second: String?
        if i < h.count {
            guard h[i] == "-" else { return nil }
            i += 1
            if i < h.count, h[i] == "L" { i += 1 }
            guard let d = digitRun(), i == h.count else { return nil }
            second = d
        }
        guard let start = Int(first) else { return nil }
        guard let second else { return (start, nil) }
        guard let end = Int(second) else { return nil }
        return (start, end)
    }

    /// `/^[a-z][a-z0-9+.-]*:/i` (ASCII only: JS `/i` without `u` doesn't fold non-ASCII into it).
    private static func hasScheme(_ u: Scalars) -> Bool {
        guard let first = u.first, isASCIILetter(first) else { return false }
        for c in u.dropFirst() {
            if c == ":" { return true }
            if !(isASCIILetter(c) || ("0"..."9").contains(c) || c == "+" || c == "." || c == "-") { return false }
        }
        return false
    }

    /// `path.split("/").filter(Boolean)`
    private static func segments(_ path: String) -> [String] {
        path.unicodeScalars.split(separator: "/").map { String(String.UnicodeScalarView($0)) }
    }

    private static func isASCIILetter(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("A"..."Z").contains(c) }

    private static func asciiLower(_ c: Unicode.Scalar) -> Unicode.Scalar {
        ("A"..."Z").contains(c) ? Unicode.Scalar(c.value + 32)! : c
    }

    private static func string(_ s: some Sequence<Unicode.Scalar>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s)
        return String(v)
    }
}
