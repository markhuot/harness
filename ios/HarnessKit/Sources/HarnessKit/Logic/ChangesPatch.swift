import Foundation

// The Changes tab's patch parser: a port of @pierre/diffs' parsePatchFiles (the part the git
// plugin's Changes UI relies on) plus the rows the native tab draws. The plugin keys "viewed" marks
// by a fingerprint of Pierre's parse (shared/src/state/changes.ts), so every field the fingerprint
// reads (paths, change type, modes, hunk positions, and each side's lines as Pierre keeps them,
// trailing newline included) must come out exactly as Pierre's do; shared/fixtures/cases/changes.ts
// runs the real parser over a corpus of patches and ChangesPatchTests checks this one against it.
//
// Deliberate differences from Pierre: only git-format patches are parsed (the plugin's patch always
// is one; a plain unified diff without `diff --git` lines gives no files), and `git format-patch`
// mailboxes ("From <sha> …" commit boundaries) aren't split, since `git diff` never writes them.

/// Pierre's `ChangeTypes`.
public enum ChangesDiffType: String, Sendable, Equatable, Codable {
    case change
    case new
    case deleted
    case renamePure = "rename-pure"
    case renameChanged = "rename-changed"
}

public enum ChangesLineKind: String, Sendable, Equatable, Codable {
    case add, del, ctx
}

/// One line of a hunk, ready to draw.
public struct ChangesLine: Sendable, Equatable, Codable {
    public var kind: ChangesLineKind
    /// The line without its sign and line ending
    public var text: String
    /// 1-based line numbers on each side; nil on the side the line isn't on
    public var oldLine: Int?
    public var newLine: Int?

    public init(kind: ChangesLineKind, text: String, oldLine: Int?, newLine: Int?) {
        self.kind = kind
        self.text = text
        self.oldLine = oldLine
        self.newLine = newLine
    }
}

public struct ChangesHunk: Sendable, Equatable {
    public var deletionStart: Int
    public var deletionCount: Int
    public var additionStart: Int
    public var additionCount: Int
    /// The text after the second `@@` (the enclosing function, when git found one)
    public var context: String?
    public var lines: [ChangesLine]

    /// The hunk header as git writes it.
    public var header: String {
        "@@ -\(deletionStart),\(deletionCount) +\(additionStart),\(additionCount) @@" + (context.map { " \($0)" } ?? "")
    }
}

/// One file of a patch: Pierre's FileDiffMetadata, the fields the fingerprint reads, plus its rows.
public struct ChangesFileDiff: Sendable, Equatable {
    /// The path (the new one for a rename)
    public var name: String
    /// The old path, for renames only
    public var prevName: String?
    public var type: ChangesDiffType
    public var mode: String?
    public var prevMode: String?
    public var hunks: [ChangesHunk]
    /// Every old-side line the hunks show (context and removed), as Pierre keeps them: with their
    /// line ending, an empty line as "\n", and no ending where git said "\ No newline at end of file"
    public var deletionLines: [String]
    /// The same for the new side (context and added)
    public var additionLines: [String]

    /// Identifies this version of the file's diff (viewed.ts `fingerprint`).
    public var fingerprint: String { ChangesPatch.fingerprint(self) }
}

public enum ChangesPatch {
    /// FNV-1a over UTF-16 code units, base 36 (viewed.ts `hash`).
    public static func hash(_ s: String) -> String {
        var x: UInt32 = 2_166_136_261
        for u in s.utf16 { x = (x ^ UInt32(u)) &* 16_777_619 }
        return String(x, radix: 36)
    }

    /// Identifies one version of a file's diff: its paths, change type, mode, hunk positions and lines.
    public static func fingerprint(_ d: ChangesFileDiff) -> String {
        let hunks = d.hunks.map { "\($0.deletionStart),\($0.deletionCount),\($0.additionStart),\($0.additionCount)" }.joined(separator: ";")
        let parts = [d.name, d.prevName ?? "", d.type.rawValue, d.prevMode ?? "", d.mode ?? "", hunks, d.deletionLines.joined(separator: "\n"), "\u{0000}", d.additionLines.joined(separator: "\n")]
        return "\(hash(parts.joined(separator: "\u{0001}"))).\(d.deletionLines.count).\(d.additionLines.count)"
    }

    /// The files of a git-format patch, in patch order.
    public static func parse(_ patch: String) -> [ChangesFileDiff] {
        let lines = splitWithNewlines(patch)
        guard lines.contains(where: { starts($0, "diff --git") }) else { return [] }
        return group(lines, at: "diff --git").compactMap { part in
            // A preamble before the first file isn't a file.
            starts(part[0], "diff --git") ? parseFile(part) : nil
        }
    }

    // MARK: One file

    private static func parseFile(_ part: [String]) -> ChangesFileDiff? {
        var file: ChangesFileDiff?
        for var lines in group(part, at: "@@ ") {
            let first = lines[0]
            guard let header = parseHunkHeader(first), file != nil else {
                // The file header (Pierre treats any part before the first hunk this way, once).
                guard file == nil else { continue }
                file = parseHeader(lines)
                continue
            }
            while let last = lines.last, lines.count > 1, last == "\n" || last == "\r" || last == "\r\n" || last.isEmpty { lines.removeLast() }
            var hunk = ChangesHunk(deletionStart: header.deletionStart, deletionCount: header.deletionCount, additionStart: header.additionStart, additionCount: header.additionCount, context: header.context, lines: [])
            var parsedAdd = 0
            var parsedDel = 0
            var oldNo = header.deletionStart
            var newNo = header.additionStart
            var last: ChangesLineKind?
            for raw in lines.dropFirst() {
                if parsedAdd >= hunk.additionCount && parsedDel >= hunk.deletionCount && !starts(raw, "\\") {
                    if !(isHunkBodyLine(raw) && !isFormatPatchVersionSeparator(raw)) { break }
                }
                guard let sign = raw.utf8.first, sign == UInt8(ascii: "+") || sign == UInt8(ascii: "-") || sign == UInt8(ascii: " ") || sign == UInt8(ascii: "\\") else { continue }
                let content = lineContent(raw)
                switch sign {
                case UInt8(ascii: "+"):
                    file!.additionLines.append(content)
                    hunk.lines.append(ChangesLine(kind: .add, text: display(content), oldLine: nil, newLine: newNo))
                    newNo += 1
                    parsedAdd += 1
                    last = .add
                case UInt8(ascii: "-"):
                    file!.deletionLines.append(content)
                    hunk.lines.append(ChangesLine(kind: .del, text: display(content), oldLine: oldNo, newLine: nil))
                    oldNo += 1
                    parsedDel += 1
                    last = .del
                case UInt8(ascii: " "):
                    file!.deletionLines.append(content)
                    file!.additionLines.append(content)
                    hunk.lines.append(ChangesLine(kind: .ctx, text: display(content), oldLine: oldNo, newLine: newNo))
                    oldNo += 1
                    newNo += 1
                    parsedAdd += 1
                    parsedDel += 1
                    last = .ctx
                default:
                    // "\ No newline at end of file": the line before it has no ending.
                    guard let last else { continue }
                    if last == .add || last == .ctx, let i = file!.additionLines.indices.last { file!.additionLines[i] = cleanLastNewline(file!.additionLines[i]) }
                    if last == .del || last == .ctx, let i = file!.deletionLines.indices.last { file!.deletionLines[i] = cleanLastNewline(file!.deletionLines[i]) }
                }
            }
            if parsedAdd != hunk.additionCount || parsedDel != hunk.deletionCount {
                // Pierre repairs a hunk whose header miscounts its lines.
                hunk.additionStart = startBoundary(hunk.additionStart, hunk.additionCount) + (parsedAdd == 0 ? 0 : 1)
                hunk.deletionStart = startBoundary(hunk.deletionStart, hunk.deletionCount) + (parsedDel == 0 ? 0 : 1)
                hunk.additionCount = parsedAdd
                hunk.deletionCount = parsedDel
            }
            file!.hunks.append(hunk)
        }
        guard var file else { return nil }
        if file.type != .renamePure && file.type != .renameChanged { file.prevName = nil }
        return file
    }

    private static func parseHeader(_ lines: [String]) -> ChangesFileDiff {
        var f = ChangesFileDiff(name: "", prevName: nil, type: .change, mode: nil, prevMode: nil, hunks: [], deletionLines: [], additionLines: [])
        for line in lines {
            if starts(line, "diff --git") {
                guard let (a, b) = gitHeaderNames(JSCompat.trim(line)) else { continue }
                let prev = decodeFileName(a, stripGitPrefix: true)
                let name = decodeFileName(b, stripGitPrefix: true)
                f.name = name
                if !same(prev, name) { f.prevName = prev }
                continue
            }
            if starts(line, "---") || starts(line, "+++"), let (type, raw) = fileNameHeader(line) {
                let name = decodeFileName(raw, stripGitPrefix: true)
                if type == "---" && name != "/dev/null" {
                    f.prevName = name
                    f.name = name
                } else if type == "+++" && name != "/dev/null" {
                    f.name = name
                }
                continue
            }
            if starts(line, "new mode ") { f.mode = JSCompat.trim(slice(line, 8)) }
            if starts(line, "old mode ") { f.prevMode = JSCompat.trim(slice(line, 8)) }
            if starts(line, "new file mode") {
                f.type = .new
                f.mode = JSCompat.trim(slice(line, 13))
            }
            if starts(line, "deleted file mode") {
                f.type = .deleted
                f.mode = JSCompat.trim(slice(line, 17))
            }
            if starts(line, "similarity index") { f.type = starts(line, "similarity index 100%") ? .renamePure : .renameChanged }
            if starts(line, "index "), let mode = indexMode(JSCompat.trim(line)) { f.mode = mode }
            if starts(line, "rename from ") || starts(line, "copy from ") { f.prevName = decodeFileName(slice(line, starts(line, "rename") ? 12 : 10)) }
            if starts(line, "rename to ") || starts(line, "copy to ") { f.name = decodeFileName(slice(line, starts(line, "rename") ? 10 : 8)) }
        }
        return f
    }

    // MARK: Headers

    struct HunkHeader {
        var deletionStart: Int
        var deletionCount: Int
        var additionStart: Int
        var additionCount: Int
        var context: String?
    }

    /// `@@ -a[,b] +c[,d] @@[ context]`
    static func parseHunkHeader(_ line: String) -> HunkHeader? {
        let u = Array(line.utf16)
        guard u.starts(with: Array("@@ -".utf16)) else { return nil }
        var i = 4
        func int() -> Int? {
            let from = i
            var n = 0
            while i < u.count, u[i] >= 48, u[i] <= 57 {
                n = n &* 10 &+ Int(u[i] - 48)
                i += 1
            }
            return i > from ? n : nil
        }
        func at(_ k: Int, _ c: Character) -> Bool { k < u.count && u[k] == c.utf16.first! }
        guard let delStart = int() else { return nil }
        var delCount = 1
        if at(i, ",") {
            i += 1
            guard let n = int() else { return nil }
            delCount = n
        }
        guard at(i, " "), at(i + 1, "+") else { return nil }
        i += 2
        guard let addStart = int() else { return nil }
        var addCount = 1
        if at(i, ",") {
            i += 1
            guard let n = int() else { return nil }
            addCount = n
        }
        guard at(i, " "), at(i + 1, "@"), at(i + 2, "@") else { return nil }
        var context: String?
        if at(i + 3, " ") {
            var rest = String(decoding: u[(i + 4)...], as: UTF16.self)
            if rest.utf16.last == 10 {
                rest = String(decoding: rest.utf16.dropLast(), as: UTF16.self)
                if rest.utf16.last == 13 { rest = String(decoding: rest.utf16.dropLast(), as: UTF16.self) }
            }
            context = rest
        }
        return HunkHeader(deletionStart: delStart, deletionCount: delCount, additionStart: addStart, additionCount: addCount, context: context)
    }

    /// `/^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*"|b\/.+?)$/` on a trimmed line.
    static func gitHeaderNames(_ line: String) -> (String, String)? {
        let u = Array(line.unicodeScalars)
        let prefix = Array("diff --git ".unicodeScalars)
        guard u.starts(with: prefix), !u.contains(where: isLineTerminator) else { return nil }
        let rest = Array(u[prefix.count...])
        // Each alternative for the a-side, in the regex's order; the first whose b-side then matches wins.
        for aEnd in aCandidates(rest) {
            guard aEnd < rest.count, rest[aEnd] == " " else { continue }
            let bStart = aEnd + 1
            if matchesQuoted(rest, from: bStart, side: "b") == rest.count || matchesPlainB(rest, from: bStart) {
                return (string(rest[..<aEnd]), string(rest[bStart...]))
            }
        }
        return nil
    }

    /// End offsets the a-side group can take, in backtracking order: the quoted form, then `a\/.+?`
    /// growing one character at a time.
    private static func aCandidates(_ s: [Unicode.Scalar]) -> [Int] {
        var out: [Int] = []
        if let q = matchesQuoted(s, from: 0, side: "a") { out.append(q) }
        if s.count >= 3, s[0] == "a", s[1] == "/" {
            out.append(contentsOf: Array(3...s.count))
        }
        return out
    }

    /// `"x\/(?:[^"\\]|\\.)*"` at `from`: the offset after the closing quote. (`.` doesn't take a line
    /// terminator, but the line has none.)
    private static func matchesQuoted(_ s: [Unicode.Scalar], from: Int, side: Unicode.Scalar) -> Int? {
        guard from + 2 < s.count, s[from] == "\"", s[from + 1] == side, s[from + 2] == "/" else { return nil }
        var i = from + 3
        while i < s.count {
            if s[i] == "\"" { return i + 1 }
            if s[i] == "\\" {
                guard i + 1 < s.count else { return nil }
                i += 2
            } else {
                i += 1
            }
        }
        return nil
    }

    /// `b\/.+?$`
    private static func matchesPlainB(_ s: [Unicode.Scalar], from: Int) -> Bool {
        s.count - from >= 3 && s[from] == "b" && s[from + 1] == "/"
    }

    /// `/^(---|\+\+\+)\s+([^\t\r\n]+)/`
    static func fileNameHeader(_ line: String) -> (String, String)? {
        let u = Array(line.unicodeScalars)
        guard u.count > 3 else { return nil }
        let type = string(u[..<3])
        guard type == "---" || type == "+++" else { return nil }
        var i = 3
        guard i < u.count, JSCompat.isWhitespace(u[i]) else { return nil }
        // \s+ backtracks, so the name starts at the first character that isn't \t\r\n after at least one \s.
        var candidates: [Int] = []
        while i < u.count, JSCompat.isWhitespace(u[i]) {
            i += 1
            candidates.append(i)
        }
        for start in candidates.reversed() {
            var end = start
            while end < u.count, u[end] != "\t", u[end] != "\r", u[end] != "\n" { end += 1 }
            if end > start { return (type, string(u[start..<end])) }
        }
        return nil
    }

    /// `/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/i`'s mode.
    static func indexMode(_ line: String) -> String? {
        let u = Array(line.unicodeScalars)
        let prefix = Array("index ".unicodeScalars)
        guard u.starts(with: prefix) else { return nil }
        var i = prefix.count
        func hex() -> Bool {
            let from = i
            while i < u.count, isHex(u[i]) { i += 1 }
            return i > from
        }
        guard hex(), i + 1 < u.count, u[i] == ".", u[i + 1] == "." else { return nil }
        i += 2
        guard hex() else { return nil }
        if i == u.count { return nil }
        guard u[i] == " " else { return nil }
        let from = i + 1
        guard from < u.count, u[from...].allSatisfy({ $0.value >= 48 && $0.value <= 57 }) else { return nil }
        return string(u[from...])
    }

    /// `decodeDiffFileName`: trimmed, a quoted name unescaped, git's a/ b/ prefix dropped when asked.
    static func decodeFileName(_ value: String, stripGitPrefix: Bool = false) -> String {
        let raw = JSCompat.trim(value)
        let name = raw.hasPrefix("\"") ? (parseQuoted(raw) ?? raw) : raw
        if stripGitPrefix, starts(name, "a/") || starts(name, "b/") { return slice(name, 2) }
        return name
    }

    /// `parseQuotedDiffFileName`: git's C-style quoting, octal escapes as UTF-8 bytes.
    static func parseQuoted(_ input: String) -> String? {
        let u = Array(input.utf16)
        guard u.first == 34 else { return nil }
        let named: [UInt16: String] = [34: "\"", 92: "\\", 97: "\u{07}", 98: "\u{08}", 116: "\t", 110: "\n", 118: "\u{0B}", 102: "\u{0C}", 114: "\r"]
        var out: [UInt16] = []
        var i = 1
        func octal(_ k: Int) -> UInt8? {
            guard k + 2 < u.count else { return nil }
            let a = Int(u[k]) - 48, b = Int(u[k + 1]) - 48, c = Int(u[k + 2]) - 48
            guard (0...3).contains(a), (0...7).contains(b), (0...7).contains(c) else { return nil }
            return UInt8(a * 64 + b * 8 + c)
        }
        while i < u.count {
            let ch = u[i]
            if ch == 34 { return String(decoding: out, as: UTF16.self) }
            if ch != 92 {
                out.append(ch)
                i += 1
                continue
            }
            if i + 1 < u.count, let esc = named[u[i + 1]] {
                out.append(contentsOf: esc.utf16)
                i += 2
                continue
            }
            var bytes: [UInt8] = []
            repeat {
                guard let b = octal(i + 1) else { return nil }
                bytes.append(b)
                i += 4
            } while i + 1 < u.count && u[i] == 92 && u[i + 1] >= 48 && u[i + 1] <= 55
            out.append(contentsOf: String(decoding: bytes, as: UTF8.self).utf16)
        }
        return nil
    }

    // MARK: Lines

    /// Pierre's `splitWithNewlines`: lines with their "\n"; "" gives [""].
    static func splitWithNewlines(_ s: String) -> [String] {
        if s.isEmpty { return [""] }
        var out: [String] = []
        var start = s.startIndex
        let u = s.utf8
        var i = u.startIndex
        while i < u.endIndex {
            if u[i] == 10 {
                let next = u.index(after: i)
                out.append(String(s[start..<next]))
                start = next
            }
            i = u.index(after: i)
        }
        if start < s.endIndex { out.append(String(s[start...])) }
        return out
    }

    /// Lines grouped so each group starts at a line beginning with `prefix` (Pierre's
    /// `splitAtLinePrefix`); lines before the first such line form a group of their own.
    private static func group(_ lines: [String], at prefix: String) -> [[String]] {
        var out: [[String]] = []
        for line in lines {
            if starts(line, prefix) || out.isEmpty { out.append([line]) } else { out[out.count - 1].append(line) }
        }
        return out
    }

    /// `rawLine.slice(1)`, an empty result as "\n".
    private static func lineContent(_ raw: String) -> String {
        let rest = slice(raw, 1)
        return rest.isEmpty ? "\n" : rest
    }

    /// A line as drawn: no "\n" or "\r\n" at the end.
    private static func display(_ content: String) -> String { cleanLastNewline(content) }

    static func cleanLastNewline(_ s: String) -> String {
        var u = Array(s.utf16)
        if u.last == 10 {
            u.removeLast()
            if u.last == 13 { u.removeLast() }
            return String(decoding: u, as: UTF16.self)
        }
        return s
    }

    private static func isHunkBodyLine(_ line: String) -> Bool {
        guard let c = line.utf8.first else { return false }
        return c == UInt8(ascii: "+") || c == UInt8(ascii: "-") || c == UInt8(ascii: " ")
    }

    private static func isFormatPatchVersionSeparator(_ line: String) -> Bool {
        guard starts(line, "--") else { return false }
        return line.utf8.dropFirst(2).allSatisfy { $0 == 32 || $0 == 9 || $0 == 10 || $0 == 13 }
    }

    private static func startBoundary(_ start: Int, _ count: Int) -> Int { start - (count == 0 ? 0 : 1) }

    // MARK: Helpers

    static func starts(_ s: String, _ prefix: String) -> Bool { s.utf8.starts(with: prefix.utf8) }

    /// `s.slice(n)` for an ASCII prefix of length n.
    static func slice(_ s: String, _ n: Int) -> String { String(decoding: s.utf16.dropFirst(n), as: UTF16.self) }

    private static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

    private static func isHex(_ c: Unicode.Scalar) -> Bool {
        ("0"..."9").contains(c) || ("a"..."f").contains(c) || ("A"..."F").contains(c)
    }

    private static func isLineTerminator(_ c: Unicode.Scalar) -> Bool {
        c == "\n" || c == "\r" || c == "\u{2028}" || c == "\u{2029}"
    }

    private static func string(_ s: some Sequence<Unicode.Scalar>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s)
        return String(v)
    }
}
