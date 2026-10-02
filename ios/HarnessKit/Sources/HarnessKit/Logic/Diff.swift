import Foundation

// Port of shared/src/diff.ts. A unified diff line by line, for clients that draw diffs themselves
// (the phone's code block): what each line is (added, removed, context, hunk or file header),
// which file it belongs to, and that file's language. Fence aliases and diff detection live in
// Code.swift (state/code.ts).

public enum DiffLineKind: String, Codable, Sendable {
    case add, del, ctx, hunk, meta
}

public struct DiffLine: Codable, Equatable, Sendable {
    public var kind: DiffLineKind
    /// The line as written, sign included
    public var text: String
    /// Which file section it belongs to (an index into `ParsedDiff.files`)
    public var file: Int

    public init(kind: DiffLineKind, text: String, file: Int) {
        self.kind = kind
        self.text = text
        self.file = file
    }
}

public struct DiffFile: Codable, Equatable, Sendable {
    /// The new path (the old one for a deletion), without git's a/ b/ prefix; nil when the diff names none
    @Nullable public var path: String?

    public init(path: String?) {
        self.path = path
    }
}

/// parseDiff's result: `{ lines, files }`.
public struct ParsedDiff: Codable, Equatable, Sendable {
    public var lines: [DiffLine]
    public var files: [DiffFile]

    public init(lines: [DiffLine], files: [DiffFile]) {
        self.lines = lines
        self.files = files
    }
}

public enum Diff {
    private static let fileNames: [String: String] = [
        "dockerfile": "docker",
        "containerfile": "docker",
        "makefile": "makefile",
        "gemfile": "ruby",
        "rakefile": "ruby",
    ]

    /// The Shiki language for a file path, by its name or extension ("app/Foo.blade.php" → blade); nil for none.
    public static func langForPath(_ path: String) -> String? {
        let last = path.unicodeScalars.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }.last ?? []
        let name = String(String.UnicodeScalarView(last)).lowercased()
        if let lang = fileNames[name] { return lang }
        if name == ".env" || Code.hasPrefix(name, ".env.") { return "dotenv" }
        if name.unicodeScalars.reversed().starts(with: ".blade.php".unicodeScalars.reversed()) { return "blade" }
        let u = Array(name.unicodeScalars)
        guard let dot = u.lastIndex(of: "."), dot > 0 else { return nil }
        return Code.codeLanguage(String(String.UnicodeScalarView(u[(dot + 1)...])))
    }

    /// `^(diff |index |new file|deleted file|similarity |dissimilarity |rename |copy |old mode|new mode|Binary files)`
    private static let headerPrefixes = ["diff ", "index ", "new file", "deleted file", "similarity ", "dissimilarity ", "rename ", "copy ", "old mode", "new mode", "Binary files"]

    /// `raw.replace(/\t.*$/, "").trim()`, nil when empty or /dev/null, without git's a/ b/ prefix.
    private static func headerPath(_ raw: String) -> String? {
        let s = Array(raw.unicodeScalars)
        // `\t.*$` matches at the first tab with no line terminator after it.
        let lastTerminator = s.lastIndex(where: Code.isLineTerminator) ?? -1
        var cut = s.count
        if let tab = s.indices.first(where: { s[$0] == "\t" && $0 > lastTerminator }) { cut = tab }
        let p = JSCompat.trim(String(String.UnicodeScalarView(s[..<cut])))
        if p.isEmpty || p == "/dev/null" { return nil }
        return Code.stripABPrefix(p)
    }

    /// `/^diff --git a\/(.*) b\/(.*)$/`'s second group: the greedy first group splits at the last
    /// ` b/`, and neither `.*` crosses a line terminator.
    private static func gitHeaderPath(_ line: String) -> String? {
        let prefix = Array("diff --git a/".unicodeScalars)
        let s = Array(line.unicodeScalars)
        guard s.starts(with: prefix) else { return nil }
        let rest = Array(s[prefix.count...])
        if rest.contains(where: Code.isLineTerminator) { return nil }
        let sep: [Unicode.Scalar] = [" ", "b", "/"]
        guard rest.count >= 3 else { return nil }
        for i in stride(from: rest.count - 3, through: 0, by: -1) where Array(rest[i..<(i + 3)]) == sep {
            return String(String.UnicodeScalarView(rest[(i + 3)...]))
        }
        return nil
    }

    /// `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/`'s counts (a missing count is 1). Counts are
    /// JS numbers, so they stay Doubles.
    private static func hunkCounts(_ line: String) -> (old: Double, new: Double)? {
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
        func optCount() -> Double?? {
            guard p < s.count, s[p] == "," else { return .some(nil) }
            p += 1
            guard let n = digits() else { return nil }
            return .some(n)
        }
        guard lit("@@ -"), digits() != nil, let oldCount = optCount(), lit(" +"), digits() != nil, let newCount = optCount(), lit(" @@") else { return nil }
        return (oldCount ?? 1, newCount ?? 1)
    }

    /// Classify each line of a unified diff, as written (no headers added or counts fixed, unlike
    /// normalizePatch). Hunk header counts decide whether a `--- `/`+++ ` line is a file header or
    /// a removed/added line starting with dashes; once a hunk's counts run out (or a hunk has none,
    /// as hand-written diffs often do), lines are judged by their first character.
    public static func parseDiff(_ text: String) -> ParsedDiff {
        var files: [DiffFile] = []
        var lines: [DiffLine] = []
        var oldLeft = 0.0
        var newLeft = 0.0
        var file = -1
        /// A `diff --git` line started the current file, and its `--- `/`+++ ` pair hasn't come yet
        var gitHeader = false
        let src = Code.splitLines(Code.normalizeCRLF(text))
        func startFile(_ path: String?) {
            files.append(DiffFile(path: path))
            file = files.count - 1
        }
        var i = 0
        while i < src.count {
            defer { i += 1 }
            let l = src[i]
            let inHunk = oldLeft > 0 || newLeft > 0
            func push(_ kind: DiffLineKind) { lines.append(DiffLine(kind: kind, text: l, file: max(file, 0))) }
            if !inHunk {
                if let path = gitHeaderPath(l) {
                    startFile(path)
                    gitHeader = true
                    push(.meta)
                    continue
                }
                if Code.hasPrefix(l, "--- "), i + 1 < src.count, Code.hasPrefix(src[i + 1], "+++ ") {
                    let path = headerPath(String(String.UnicodeScalarView(src[i + 1].unicodeScalars.dropFirst(4))))
                        ?? headerPath(String(String.UnicodeScalarView(l.unicodeScalars.dropFirst(4))))
                    // A `diff --git` line already started this file; otherwise the header pair does.
                    if !gitHeader { startFile(path) } else if let path { files[file].path = path }
                    gitHeader = false
                    push(.meta)
                    i += 1
                    lines.append(DiffLine(kind: .meta, text: src[i], file: file))
                    continue
                }
                if headerPrefixes.contains(where: { Code.hasPrefix(l, $0) }) || Code.hasPrefix(l, "\\") {
                    push(.meta)
                    continue
                }
            }
            let counts = hunkCounts(l)
            if counts != nil || (!inHunk && Code.hasPrefix(l, "@@")) {
                if file < 0 { startFile(nil) }
                gitHeader = false
                oldLeft = counts?.old ?? 0
                newLeft = counts?.new ?? 0
                push(.hunk)
                continue
            }
            if file < 0 { startFile(nil) }
            switch l.unicodeScalars.first {
            case "+":
                newLeft = max(0, newLeft - 1)
                push(.add)
            case "-":
                oldLeft = max(0, oldLeft - 1)
                push(.del)
            case "\\":
                push(.meta)
            default:
                oldLeft = max(0, oldLeft - 1)
                newLeft = max(0, newLeft - 1)
                push(.ctx)
            }
        }
        if files.isEmpty { files.append(DiffFile(path: nil)) }
        return ParsedDiff(lines: lines, files: files)
    }
}
