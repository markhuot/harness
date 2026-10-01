import Foundation

// Port of shared/src/state/markdown.ts. Markdown-ish parsing for agent summaries and transcript
// text: paragraphs, headings, bullet / numbered lists, fenced code, quotes, rules, GFM pipe tables,
// and inline code / bold / italic / links. Pure: each client renders the blocks and tokens with its
// own primitives (DOM on desktop, Text on iOS), so agent output can never inject markup.
//
// The TS regexes run through NSRegularExpression, which matches on UTF-16 like JS does. ICU's
// classes and anchors don't mean what JS's do, so each pattern spells them out:
//   - `\s` is the ECMAScript whitespace set (JSCompat.isWhitespace: NBSP and BOM yes, NEL no),
//   - `\d`, `\w` and `\b` are ASCII,
//   - `.` excludes only JS's line terminators (\n, \r, U+2028, U+2029),
//   - `$` without the m flag is `\z` (ICU's `$` also matches before a final line terminator),
//   - `^` with the m flag is "at the start or after a JS line terminator".

public enum Markdown {
    public enum Align: String, Codable, Sendable {
        case left, center, right
    }

    /// A block, encoded like the TS union: `{ t: "p", text }`, `{ t: "table", align, header, rows }`…
    public enum Block: Codable, Equatable, Sendable {
        case p(text: String)
        case h(level: Int, text: String)
        case ul(items: [String])
        case ol(items: [String])
        case code(lang: String, text: String)
        case quote(text: String)
        /// `align` has one entry per column; nil is a column without a `:` (no alignment).
        case table(align: [Align?], header: [String], rows: [[String]])
        case hr

        private enum CodingKeys: String, CodingKey { case t, text, level, items, lang, align, header, rows }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let t = try c.decode(String.self, forKey: .t)
            switch t {
            case "p": self = .p(text: try c.decode(String.self, forKey: .text))
            case "h": self = .h(level: try c.decode(Int.self, forKey: .level), text: try c.decode(String.self, forKey: .text))
            case "ul": self = .ul(items: try c.decode([String].self, forKey: .items))
            case "ol": self = .ol(items: try c.decode([String].self, forKey: .items))
            case "code": self = .code(lang: try c.decode(String.self, forKey: .lang), text: try c.decode(String.self, forKey: .text))
            case "quote": self = .quote(text: try c.decode(String.self, forKey: .text))
            case "table":
                self = .table(
                    align: try c.decode([Align?].self, forKey: .align),
                    header: try c.decode([String].self, forKey: .header),
                    rows: try c.decode([[String]].self, forKey: .rows)
                )
            case "hr": self = .hr
            default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "Unknown block \(t)")
            }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .p(text):
                try c.encode("p", forKey: .t)
                try c.encode(text, forKey: .text)
            case let .h(level, text):
                try c.encode("h", forKey: .t)
                try c.encode(level, forKey: .level)
                try c.encode(text, forKey: .text)
            case let .ul(items):
                try c.encode("ul", forKey: .t)
                try c.encode(items, forKey: .items)
            case let .ol(items):
                try c.encode("ol", forKey: .t)
                try c.encode(items, forKey: .items)
            case let .code(lang, text):
                try c.encode("code", forKey: .t)
                try c.encode(lang, forKey: .lang)
                try c.encode(text, forKey: .text)
            case let .quote(text):
                try c.encode("quote", forKey: .t)
                try c.encode(text, forKey: .text)
            case let .table(align, header, rows):
                try c.encode("table", forKey: .t)
                try c.encode(align, forKey: .align)
                try c.encode(header, forKey: .header)
                try c.encode(rows, forKey: .rows)
            case .hr:
                try c.encode("hr", forKey: .t)
            }
        }
    }

    /// An inline token, encoded like the TS union: `{ t: "link", text, url }`, `{ t: "ticket", key }`…
    public enum InlineToken: Codable, Equatable, Sendable {
        case text(String)
        case code(String)
        case strong(String)
        case em(String)
        case link(text: String, url: String)
        case ticket(key: String)

        private enum CodingKeys: String, CodingKey { case t, text, url, key }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let t = try c.decode(String.self, forKey: .t)
            switch t {
            case "text": self = .text(try c.decode(String.self, forKey: .text))
            case "code": self = .code(try c.decode(String.self, forKey: .text))
            case "strong": self = .strong(try c.decode(String.self, forKey: .text))
            case "em": self = .em(try c.decode(String.self, forKey: .text))
            case "link": self = .link(text: try c.decode(String.self, forKey: .text), url: try c.decode(String.self, forKey: .url))
            case "ticket": self = .ticket(key: try c.decode(String.self, forKey: .key))
            default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "Unknown inline token \(t)")
            }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .text(s):
                try c.encode("text", forKey: .t)
                try c.encode(s, forKey: .text)
            case let .code(s):
                try c.encode("code", forKey: .t)
                try c.encode(s, forKey: .text)
            case let .strong(s):
                try c.encode("strong", forKey: .t)
                try c.encode(s, forKey: .text)
            case let .em(s):
                try c.encode("em", forKey: .t)
                try c.encode(s, forKey: .text)
            case let .link(text, url):
                try c.encode("link", forKey: .t)
                try c.encode(text, forKey: .text)
                try c.encode(url, forKey: .url)
            case let .ticket(key):
                try c.encode("ticket", forKey: .t)
                try c.encode(key, forKey: .key)
            }
        }
    }

    // MARK: Blocks

    public static func parseBlocks(_ src: String) -> [Block] {
        let lines = splitLines(src)
        var blocks: [Block] = []
        var para: [String] = []
        func flush() {
            if !para.isEmpty { blocks.append(.p(text: para.joined(separator: "\n"))) }
            para = []
        }
        var i = 0
        while i < lines.count {
            defer { i += 1 }
            let line = lines[i]
            if let fence = Pattern.fence.exec(line) {
                flush()
                let marker = Array(fence[1]!.unicodeScalars)
                var body: [String] = []
                i += 1
                while i < lines.count, !Array(JSCompat.trim(lines[i]).unicodeScalars).starts(with: marker) {
                    body.append(lines[i])
                    i += 1
                }
                blocks.append(.code(lang: fence[2] ?? "", text: body.joined(separator: "\n")))
                // The TS `continue` skips the closing fence (its `i++`); `defer` does the same.
                continue
            }
            if JSCompat.trim(line).isEmpty {
                flush()
                continue
            }
            let align = includesPipe(line) && i + 1 < lines.count ? delimiterRow(lines[i + 1]) : nil
            if let align {
                let header = splitRow(line)
                if header.count == align.count {
                    flush()
                    var rows: [[String]] = []
                    i += 1
                    while i + 1 < lines.count, includesPipe(lines[i + 1]), !JSCompat.trim(lines[i + 1]).isEmpty {
                        i += 1
                        let cells = splitRow(lines[i])
                        rows.append(header.indices.map { $0 < cells.count ? cells[$0] : "" })
                    }
                    blocks.append(.table(align: align, header: header, rows: rows))
                    continue
                }
            }
            if let h = Pattern.heading.exec(line) {
                flush()
                blocks.append(.h(level: h[1]!.utf16.count, text: h[2]!))
                continue
            }
            if Pattern.rule.test(line) {
                flush()
                blocks.append(.hr)
                continue
            }
            if let li = Pattern.listItem.exec(line) {
                flush()
                let ordered = hasDigit(li[1]!)
                var items = [li[2]!]
                while i + 1 < lines.count {
                    if let next = Pattern.listItem.exec(lines[i + 1]), hasDigit(next[1]!) == ordered {
                        items.append(next[2]!)
                        i += 1
                    } else if Pattern.continuation.test(lines[i + 1]) {
                        i += 1
                        items[items.count - 1] += " " + JSCompat.trim(lines[i])
                    } else {
                        break
                    }
                }
                blocks.append(ordered ? .ol(items: items) : .ul(items: items))
                continue
            }
            if line.unicodeScalars.first == ">" {
                flush()
                var q = [Pattern.quotePrefix.replace(line, with: "")]
                while i + 1 < lines.count, lines[i + 1].unicodeScalars.first == ">" {
                    i += 1
                    q.append(Pattern.quotePrefix.replace(lines[i], with: ""))
                }
                blocks.append(.quote(text: q.joined(separator: "\n")))
                continue
            }
            para.append(line)
        }
        flush()
        return blocks
    }

    // MARK: Inline

    /// Inline markup of one line. [label](x) is a link when x is http(s) or a file link (`harness://file/…`,
    /// or a path with no scheme; see parseFileLink); other targets (javascript:, data:, anchors) keep only
    /// the label. Bare URLs are autolinked only for http(s).
    /// An UPPERCASE-NN word is a "ticket" token; renderers link it only when it names a ticket they
    /// can open (ticketLinkable), so "UTF-8" or "SHA-256" stay plain text.
    public static func inlineTokens(_ text: String) -> [InlineToken] {
        let ns = text as NSString
        var out: [InlineToken] = []
        var last = 0
        for m in Pattern.inline.regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let idx = m.range.location
            if idx > last { out.append(.text(ns.substring(with: NSRange(location: last, length: idx - last)))) }
            let s = ns.substring(with: m.range)
            let len = m.range.length
            func inner(_ trim: Int) -> String { ns.substring(with: NSRange(location: idx + trim, length: len - 2 * trim)) }
            if participated(m, 1) {
                out.append(.code(inner(1)))
            } else if participated(m, 2) {
                out.append(.strong(inner(2)))
            } else if participated(m, 3) {
                out.append(.em(inner(1)))
            } else if participated(m, 4) {
                let mm = Pattern.linkParts.exec(s)!
                let label = mm[1]!, url = mm[2]!
                out.append(Pattern.httpScheme.test(url) || FileLinks.parseFileLink(url) != nil ? .link(text: label, url: url) : .text(label))
            } else if participated(m, 5) {
                out.append(.link(text: s, url: s))
            } else if participated(m, 6) {
                out.append(.ticket(key: s))
            }
            last = idx + len
        }
        if last < ns.length { out.append(.text(ns.substring(from: last))) }
        return out
    }

    // MARK: Plain text

    /// Plain-text preview of markdown for card snippets.
    public static func plainText(_ md: String) -> String {
        var s = Pattern.fencedSpan.replace(md, with: " ")
        s = mapLines(s) { line in
            if delimiterRow(line) != nil { return "" }
            return Pattern.tableLine.test(line) ? splitRow(line).joined(separator: " · ") : line
        }
        s = Pattern.codeSpan.replace(s, with: "$1")
        s = Pattern.strongSpan.replace(s, with: "$1")
        s = Pattern.linkSpan.replace(s, with: "$1")
        s = Pattern.headingMarks.replace(s, with: "")
        s = Pattern.bulletMarks.replace(s, with: "• ")
        s = Pattern.whitespaceRun.replace(s, with: " ")
        return JSCompat.trim(s)
    }

    // MARK: Tables

    /// Cells of one GFM table row. `\|` is a literal pipe, and so is a pipe inside a `code span`.
    private static func splitRow(_ line: String) -> [String] {
        var s = Array(JSCompat.trim(line).unicodeScalars)[...]
        if s.first == "|" { s = s.dropFirst() }
        if s.last == "|", !(s.count >= 2 && s[s.endIndex - 2] == "\\") { s = s.dropLast() }
        var cells: [String] = []
        var cell = String.UnicodeScalarView()
        var tick = false
        var i = s.startIndex
        while i < s.endIndex {
            let ch = s[i]
            if ch == "\\", i + 1 < s.endIndex, s[i + 1] == "|" {
                cell.append("|")
                i += 1
            } else if ch == "`" {
                tick.toggle()
                cell.append(ch)
            } else if ch == "|", !tick {
                cells.append(JSCompat.trim(String(cell)))
                cell = String.UnicodeScalarView()
            } else {
                cell.append(ch)
            }
            i += 1
        }
        cells.append(JSCompat.trim(String(cell)))
        return cells
    }

    /// The `| --- | :-: |` row under a table header: its alignments, or nil when the line isn't one.
    private static func delimiterRow(_ line: String) -> [Align?]? {
        guard includesPipe(line), line.unicodeScalars.contains("-") else { return nil }
        let cells = splitRow(line)
        guard cells.allSatisfy(isDelimiterCell) else { return nil }
        return cells.map { c in
            let u = c.unicodeScalars
            let starts = u.first == ":", ends = u.last == ":"
            return starts && ends ? .center : ends ? .right : starts ? .left : nil
        }
    }

    /// `/^:?-+:?$/`
    private static func isDelimiterCell(_ c: String) -> Bool {
        var u = Array(c.unicodeScalars)[...]
        if u.first == ":" { u = u.dropFirst() }
        if u.last == ":" { u = u.dropLast() }
        return !u.isEmpty && u.allSatisfy { $0 == "-" }
    }

    // MARK: Helpers

    private static func includesPipe(_ s: String) -> Bool { s.unicodeScalars.contains("|") }

    /// `/\d/.test(s)`
    private static func hasDigit(_ s: String) -> Bool { s.unicodeScalars.contains { ("0"..."9").contains($0) } }

    /// `src.replace(/\r\n/g, "\n").split("\n")`, on scalars (a Swift Character would fuse "\r\n").
    private static func splitLines(_ src: String) -> [String] {
        var lines: [String] = []
        var cur = String.UnicodeScalarView()
        var pendingCR = false
        for u in src.unicodeScalars {
            if pendingCR {
                pendingCR = false
                if u == "\n" {
                    lines.append(String(cur))
                    cur = String.UnicodeScalarView()
                    continue
                }
                cur.append("\r")
            }
            if u == "\r" {
                pendingCR = true
            } else if u == "\n" {
                lines.append(String(cur))
                cur = String.UnicodeScalarView()
            } else {
                cur.append(u)
            }
        }
        if pendingCR { cur.append("\r") }
        lines.append(String(cur))
        return lines
    }

    /// `s.replace(/^.*$/gm, fn)`: each run between JS line terminators goes through `fn`, and the
    /// terminators stay as they were.
    private static func mapLines(_ s: String, _ fn: (String) -> String) -> String {
        var out = ""
        var cur = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            if isLineTerminator(u) {
                out += fn(String(cur))
                out.unicodeScalars.append(u)
                cur = String.UnicodeScalarView()
            } else {
                cur.append(u)
            }
        }
        out += fn(String(cur))
        return out
    }

    private static func isLineTerminator(_ u: Unicode.Scalar) -> Bool {
        u == "\n" || u == "\r" || u == "\u{2028}" || u == "\u{2029}"
    }

    private static func participated(_ m: NSTextCheckingResult, _ group: Int) -> Bool {
        m.range(at: group).location != NSNotFound
    }

    /// A JS regex rewritten for ICU (see the top of the file).
    private struct Pattern: @unchecked Sendable {
        let regex: NSRegularExpression

        init(_ pattern: String) {
            regex = try! NSRegularExpression(pattern: pattern)
        }

        /// `re.exec(s)` → the groups (index 0 is the whole match), nil for groups that didn't take part.
        func exec(_ s: String) -> [String?]? {
            let ns = s as NSString
            guard let m = regex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
            return (0..<m.numberOfRanges).map { k in
                let r = m.range(at: k)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }
        }

        func test(_ s: String) -> Bool {
            regex.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
        }

        /// `s.replace(re, template)` for a /g regex (or one anchored with `^`, which can match only
        /// once). `$1` in the template works as in JS.
        func replace(_ s: String, with template: String) -> String {
            regex.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: template)
        }

        /// ECMAScript `\s` (WhiteSpace + LineTerminator), for use inside a character class.
        static let ws = #"\t\n\u000B\f\r    -     　﻿"#
        static let s = "[\(ws)]"
        static let notS = "[^\(ws)]"
        /// JS `.` (no s flag).
        static let dot = #"[^\n\r  ]"#
        /// JS `^` with the m flag.
        static let lineStart = #"(?<![^\n\r  ])"#

        /// `/^\s*(```|~~~)\s*([\w+-]*)\s*$/`
        static let fence = Pattern("^\(s)*(```|~~~)\(s)*([A-Za-z0-9_+-]*)\(s)*\\z")
        /// `/^(#{1,4})\s+(.*)$/`
        static let heading = Pattern("^(#{1,4})\(s)+(\(dot)*)\\z")
        /// `/^\s*(-{3,}|\*{3,})\s*$/`
        static let rule = Pattern("^\(s)*(-{3,}|\\*{3,})\(s)*\\z")
        /// `/^\s*([-*+]|\d+[.)])\s+(.*)$/`
        static let listItem = Pattern("^\(s)*([-*+]|[0-9]+[.)])\(s)+(\(dot)*)\\z")
        /// `/^\s{2,}\S/`
        static let continuation = Pattern("^\(s){2,}\(notS)")
        /// `/^>\s?/` (no g flag, but it's anchored, so it can match only once)
        static let quotePrefix = Pattern("^>\(s)?")
        /// INLINE: `` /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)|(\b[A-Z][A-Z0-9]*-\d+\b)/g ``
        static let inline = Pattern(
            "(`[^`]+`)"
                + "|(\\*\\*[^*]+\\*\\*)"
                + "|(\\*[^*\(ws)][^*]*\\*|_[^_\(ws)][^_]*_)"
                + "|(\\[[^\\]]+\\]\\([^)\(ws)]+\\))"
                + "|(https?://[^\(ws))<>]+)"
                + "|((?<![A-Za-z0-9_])[A-Z][A-Z0-9]*-[0-9]+(?![A-Za-z0-9_]))"
        )
        /// `/^\[([^\]]+)\]\(([^)\s]+)\)$/`
        static let linkParts = Pattern("^\\[([^\\]]+)\\]\\(([^)\(ws)]+)\\)\\z")
        /// `/^https?:/`
        static let httpScheme = Pattern("^https?:")
        /// `/```[\s\S]*?```/g`
        static let fencedSpan = Pattern("```[\\s\\S]*?```")
        /// `/^\s*\|.*\|\s*$/` (applied to one line)
        static let tableLine = Pattern("^\(s)*\\|\(dot)*\\|\(s)*\\z")
        /// `` /`([^`]+)`/g ``
        static let codeSpan = Pattern("`([^`]+)`")
        /// `/\*\*([^*]+)\*\*/g`
        static let strongSpan = Pattern("\\*\\*([^*]+)\\*\\*")
        /// `/\[([^\]]+)\]\([^)]+\)/g`
        static let linkSpan = Pattern("\\[([^\\]]+)\\]\\([^)]+\\)")
        /// `/^#+\s+/gm`
        static let headingMarks = Pattern("\(lineStart)#+\(s)+")
        /// `/^\s*[-*+]\s+/gm`
        static let bulletMarks = Pattern("\(lineStart)\(s)*[-*+]\(s)+")
        /// `/\s+/g`
        static let whitespaceRun = Pattern("\(s)+")
    }
}
