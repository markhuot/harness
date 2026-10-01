import Foundation

// Port of shared/src/state/code.ts. Fenced code in agent messages: which Shiki language a fence's
// info string names, whether a block is a unified diff, and a patch cleaned up enough for a diff
// renderer to parse. Agents write diffs by hand, so hunk headers are often missing, bare (`@@ @@`)
// or miscounted; normalizePatch recounts them.
//
// Lines are split, compared and prefix-checked on Unicode scalars, not Characters: JS works on
// code units, and a Swift Character can glue "\r\n" into one element or swallow the space of
// "--- " into a grapheme with a following combining mark.

public enum Code {
    /// How to show a fenced block.
    public enum Kind: String, Codable, Sendable {
        case diff, code
    }

    /// Fence names agents use that Shiki spells differently. Anything else passes through lowercased.
    static let aliases: [String: String] = [
        "ts": "typescript",
        "mts": "typescript",
        "cts": "typescript",
        "js": "javascript",
        "mjs": "javascript",
        "cjs": "javascript",
        "node": "javascript",
        "sh": "shellscript",
        "bash": "shellscript",
        "zsh": "shellscript",
        "shell": "shellscript",
        "console": "shellsession",
        "terminal": "shellsession",
        "yml": "yaml",
        "py": "python",
        "python3": "python",
        "rb": "ruby",
        "rs": "rust",
        "golang": "go",
        "kt": "kotlin",
        "kts": "kotlin",
        "cs": "csharp",
        "c#": "csharp",
        "c++": "cpp",
        "cc": "cpp",
        "hpp": "cpp",
        "h": "c",
        "objc": "objective-c",
        "md": "markdown",
        "mdx": "mdx",
        "htm": "html",
        "svg": "xml",
        "plist": "xml",
        "ps1": "powershell",
        "pwsh": "powershell",
        "dockerfile": "docker",
        "containerfile": "docker",
        "jsonl": "json",
        "json5": "json5",
        "tf": "hcl",
        "hcl": "hcl",
        "proto": "protobuf",
        "vue": "vue",
        "blade": "blade",
        "env": "dotenv",
        "ini": "ini",
        "conf": "ini",
        "toml": "toml",
        "gql": "graphql",
        "patch": "diff",
        "udiff": "diff",
        "text": "text",
        "txt": "text",
        "plain": "text",
        "plaintext": "text",
        "output": "text",
        "log": "text",
    ]

    /// The Shiki language for a fence's info string (`ts`, `YAML`, ``) — "text" when it names none.
    ///
    /// The TS looks the name up on a plain object, so `constructor` or `toString` come back as
    /// Object.prototype members; here every unknown name passes through.
    public static func codeLanguage(_ fence: String) -> String {
        let name = JSCompat.trim(fence).lowercased()
        if name.isEmpty { return "text" }
        return aliases[name] ?? name
    }

    /// Whether an untagged block reads as a unified diff: a real `@@ -a,b +c,d @@` hunk or a file header.
    public static func looksLikeDiff(_ text: String) -> Bool {
        let lines = splitLines(normalizeCRLF(text))
        return lines.indices.contains { isStrictHunk(lines[$0]) || fileHeaderAt(lines, $0) }
    }

    /// How to show a fenced block: as a diff (tagged `diff`/`patch`, or untagged and diff-shaped) or as code.
    public static func codeKind(fence: String, text: String) -> Kind {
        if codeLanguage(fence) == "diff" { return .diff }
        return JSCompat.trim(fence).isEmpty && looksLikeDiff(text) ? .diff : .code
    }

    /// A diff block as a patch a diff renderer parses: file headers added when missing, a
    /// `diff --git` line before each `---` / `+++` pair that lacks one (so files are named without
    /// a/ b/), a hunk header added when there's none, and every hunk header rewritten with the
    /// counts of the lines under it. Context lines missing their leading space get one.
    ///
    /// Hunk starts are JS numbers, so a start past 2^53 prints the way JS prints it; where the TS
    /// then throws (a start that prints in exponent form, past 1e21), this keeps going.
    public static func normalizePatch(_ text: String, name: String = "snippet") -> String {
        var lines = splitLines(trimTrailingNewlines(normalizeCRLF(text)))
        var out: [String] = []
        // With a file header, anything before it (a commit message) is kept as is. Without one we
        // add a header, and lines before the first hunk header (or all of them) become a hunk of
        // their own.
        if !lines.indices.contains(where: { fileHeaderAt(lines, $0) }) {
            if looseHunk(lines[0]) == nil { lines.insert("@@ @@", at: 0) }
            lines.insert(contentsOf: ["--- a/\(name)", "+++ b/\(name)"], at: 0)
        }
        var nextOld = 1.0
        var nextNew = 1.0
        var git = false // inside a `diff --git` header
        var i = 0
        while i < lines.count {
            let line = lines[i]
            guard let m = looseHunk(line) else {
                // File headers and metadata between hunks.
                if hasPrefix(line, "diff --git ") { git = true }
                if fileHeaderAt(lines, i) {
                    nextOld = 1
                    nextNew = 1
                    if !git && hasPrefix(line, "--- ") {
                        let path = headerPath(line) ?? headerPath(lines[i + 1]) ?? name
                        out.append("diff --git a/\(path) b/\(path)")
                    }
                }
                out.append(line)
                i += 1
                continue
            }
            var end = i + 1
            while end < lines.count && looseHunk(lines[end]) == nil && !fileHeaderAt(lines, end) { end += 1 }
            let oldStart = m.oldStart ?? nextOld
            let newStart = m.newStart ?? nextNew
            let body = hunk(Array(lines[(i + 1)..<end]), oldStart: oldStart, newStart: newStart, context: m.context)
            out.append(contentsOf: body.lines)
            git = false
            nextOld = oldStart + Double(body.del)
            nextNew = newStart + Double(body.add)
            i = end
        }
        return out.joined(separator: "\n") + "\n"
    }

    /// One hunk: its header with recounted lines, then its body with context lines made explicit.
    private static func hunk(_ body: [String], oldStart: Double, newStart: Double, context: String) -> (lines: [String], del: Int, add: Int) {
        var del = 0
        var add = 0
        let lines = body.map { l -> String in
            switch l.unicodeScalars.first {
            case "-": del += 1
            case "+": add += 1
            case "\\": break
            case let c:
                del += 1
                add += 1
                return c == " " ? l : " " + l
            }
            return l
        }
        let header = "@@ -\(JSCompat.string(oldStart)),\(del) +\(JSCompat.string(newStart)),\(add) @@\(context)"
        return ([header] + lines, del, add)
    }

    /// A `---` / `+++` path without its a/ b/ prefix or trailing timestamp; nil for /dev/null.
    private static func headerPath(_ line: String) -> String? {
        let rest = line.unicodeScalars.dropFirst(4)
        let field = rest.prefix { $0 != "\t" }
        let p = JSCompat.trim(String(String.UnicodeScalarView(field)))
        if p == "/dev/null" { return nil }
        return stripABPrefix(p)
    }

    // MARK: - Line helpers shared with Diff and FileViewer

    /// `text.replace(/\r\n/g, "\n")`.
    static func normalizeCRLF(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingCR = false
        for c in s.unicodeScalars {
            if pendingCR {
                if c != "\n" { out.append("\r") }
                pendingCR = false
            }
            if c == "\r" { pendingCR = true } else { out.append(c) }
        }
        if pendingCR { out.append("\r") }
        return String(out)
    }

    /// `text.replace(/\n+$/, "")`.
    private static func trimTrailingNewlines(_ s: String) -> String {
        var scalars = s.unicodeScalars[...]
        while scalars.last == "\n" { scalars.removeLast() }
        return String(String.UnicodeScalarView(scalars))
    }

    /// `text.split("\n")`: always at least one element, empty pieces kept.
    static func splitLines(_ s: String) -> [String] {
        s.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map { String(String.UnicodeScalarView($0)) }
    }

    /// `s.startsWith(prefix)`, on scalars.
    static func hasPrefix(_ s: String, _ prefix: String) -> Bool {
        s.unicodeScalars.starts(with: prefix.unicodeScalars)
    }

    /// `p.replace(/^[ab]\//, "")`.
    static func stripABPrefix(_ p: String) -> String {
        let u = p.unicodeScalars
        if let f = u.first, f == "a" || f == "b", u.dropFirst().first == "/" {
            return String(String.UnicodeScalarView(u.dropFirst(2)))
        }
        return p
    }

    /// What a JS regex `.` refuses to match (and so where a `.*$` stops short of the end).
    static func isLineTerminator(_ c: Unicode.Scalar) -> Bool {
        c == "\n" || c == "\r" || c == "\u{2028}" || c == "\u{2029}"
    }

    static func isASCIIDigit(_ c: Unicode.Scalar) -> Bool {
        c.value >= 0x30 && c.value <= 0x39
    }

    /// Whether `lines[i]` starts a file header: `diff --git`, or `--- x` directly followed by `+++ y`.
    private static func fileHeaderAt(_ lines: [String], _ i: Int) -> Bool {
        let l = lines[i]
        return hasPrefix(l, "diff --git ") || (hasPrefix(l, "--- ") && i + 1 < lines.count && hasPrefix(lines[i + 1], "+++ "))
    }

    /// `/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/`.
    private static func isStrictHunk(_ line: String) -> Bool {
        let s = Array(line.unicodeScalars)
        var p = 0
        func lit(_ t: String) -> Bool {
            for c in t.unicodeScalars {
                guard p < s.count, s[p] == c else { return false }
                p += 1
            }
            return true
        }
        func digits() -> Bool {
            let from = p
            while p < s.count && isASCIIDigit(s[p]) { p += 1 }
            return p > from
        }
        func optCount() -> Bool {
            guard p < s.count, s[p] == "," else { return true }
            p += 1
            return digits()
        }
        // Backtracking can't help: each digit run is followed by a non-digit literal.
        return lit("@@ -") && digits() && optCount() && lit(" +") && digits() && optCount() && lit(" @@")
    }

    private struct LooseHunk {
        var oldStart: Double?
        var newStart: Double?
        var context: String
    }

    /// `/^@@(?:\s+-?(\d+)?(?:,\d+)?)?(?:\s+\+?(\d+)?(?:,\d+)?)?\s*@@(.*)$/`, matched the way a
    /// backtracking engine does: every quantifier greedy, alternatives tried in the same order, so
    /// the captures are the ones JS reports. `\s` is the JS set, `\d` ASCII, and `(.*)$` fails when
    /// the rest of the line holds a line terminator (a lone `\r`, U+2028).
    private static func looseHunk(_ line: String) -> LooseHunk? {
        let s = Array(line.unicodeScalars)
        guard s.count >= 2, s[0] == "@", s[1] == "@" else { return nil }
        let lastTerminator = s.lastIndex(where: isLineTerminator) ?? -1

        func run(_ from: Int, _ pred: (Unicode.Scalar) -> Bool) -> Int {
            var q = from
            while q < s.count && pred(s[q]) { q += 1 }
            return q - from
        }
        /// `\s*@@(.*)$` from `p`. `\s*` only ever succeeds at its longest: a shorter run leaves
        /// whitespace where `@` must be.
        func tail(_ p: Int) -> String? {
            let q = p + run(p, JSCompat.isWhitespace)
            guard q + 1 < s.count, s[q] == "@", s[q + 1] == "@" else { return nil }
            let rest = q + 2
            guard lastTerminator < rest else { return nil }
            return String(String.UnicodeScalarView(s[rest...]))
        }
        /// `(?:\s+<sign>?(\d+)?(?:,\d+)?)?` from `p`, calling `k` with each way it can end (in
        /// priority order, the skipped group last) until `k` succeeds.
        func group<R>(_ p: Int, _ sign: Unicode.Scalar, _ k: (Int, Range<Int>?) -> R?) -> R? {
            let ws = run(p, JSCompat.isWhitespace)
            if ws > 0 {
                for wl in stride(from: ws, through: 1, by: -1) {
                    let afterWS = p + wl
                    let signs = afterWS < s.count && s[afterWS] == sign ? [afterWS + 1, afterWS] : [afterWS]
                    for q in signs {
                        let d = run(q, isASCIIDigit)
                        var digitEnds: [(Int, Range<Int>?)] = stride(from: d, through: 1, by: -1).map { (q + $0, q..<(q + $0)) }
                        digitEnds.append((q, nil))
                        for (q3, cap) in digitEnds {
                            var ends: [Int] = []
                            if q3 < s.count && s[q3] == "," {
                                let e = run(q3 + 1, isASCIIDigit)
                                ends += stride(from: e, through: 1, by: -1).map { q3 + 1 + $0 }
                            }
                            ends.append(q3)
                            for q4 in ends {
                                if let r = k(q4, cap) { return r }
                            }
                        }
                    }
                }
            }
            return k(p, nil)
        }
        func number(_ r: Range<Int>?) -> Double? {
            r.map { Double(String(String.UnicodeScalarView(s[$0])))! }
        }
        return group(2, "-") { a, oldCap in
            group(a, "+") { b, newCap in
                tail(b).map { LooseHunk(oldStart: number(oldCap), newStart: number(newCap), context: $0) }
            }
        }
    }
}
