import Foundation

// Port of shared/src/mentions.ts. @-mentions of project files in prompts and messages, like Claude
// Code's: `@src/app.ts`, or `@"docs/with space.md"` when the path has whitespace. The composers use
// activeMention and insertMention to autocomplete the one being typed; the service uses
// parseMentions to attach the mentioned files to the run's prompt and rankPaths to answer the
// autocomplete.
//
// Offsets (caret, start, end) are UTF-16 code-unit indices, as in JS and as UITextView/NSRange
// report them. A SwiftUI `TextSelection` (String.Index) converts with `utf16Offset(in:)`.

/// The mention the caret is in: text[start, end) (UTF-16 offsets) is replaced when one is picked.
public struct ActiveMention: Codable, Equatable, Sendable {
    public var start: Int
    public var end: Int
    /// What's typed between the @ (or @") and the caret.
    public var query: String
    public var quoted: Bool

    public init(start: Int, end: Int, query: String, quoted: Bool) {
        self.start = start
        self.end = end
        self.query = query
        self.quoted = quoted
    }
}

/// Text after an edit, with the caret (a UTF-16 offset) where the edit puts it.
public struct TextInsertion: Codable, Equatable, Sendable {
    public var text: String
    public var caret: Int

    public init(text: String, caret: Int) {
        self.text = text
        self.caret = caret
    }
}

public enum Mentions {
    /// The mention being typed at `caret` (a UTF-16 offset), or nil when the caret isn't in one.
    public static func activeMention(_ text: String, caret: Int) -> ActiveMention? {
        let t = JS.units(text)
        if caret < 0 || caret > t.count { return nil }
        // Quoted: @" then anything but a quote or newline up to the caret.
        var i = caret - 1
        while i >= 1 {
            let ch = t[i]
            if ch == JS.newline { break }
            if ch == JS.quote {
                if t[i - 1] == JS.at && atBoundary(t, i - 1) {
                    let close = JS.indexOf(t, JS.quote, from: caret)
                    let newline = JS.indexOf(t, JS.newline, from: caret)
                    let end = close != -1 && (newline == -1 || close < newline) ? close + 1 : caret
                    return ActiveMention(start: i - 1, end: end, query: JS.string(t[(i + 1)..<caret]), quoted: true)
                }
                break
            }
            i -= 1
        }
        // Unquoted: @ then non-whitespace up to the caret; the mention runs to the end of the word.
        i = caret - 1
        while i >= 0 && !JS.isSpace(t[i]) && t[i] != JS.at { i -= 1 }
        if i < 0 || t[i] != JS.at || !atBoundary(t, i) { return nil }
        let query = t[(i + 1)..<caret]
        if query.first == JS.quote { return nil }
        var end = caret
        while end < t.count && !JS.isSpace(t[end]) { end += 1 }
        return ActiveMention(start: i, end: end, query: JS.string(query), quoted: false)
    }

    /// How a path is written as a mention.
    public static func formatMention(_ path: String) -> String {
        let p = JS.units(path)
        guard p.contains(where: { JS.isSpace($0) || $0 == JS.quote }) else { return "@" + path }
        return "@\"" + JS.string(p.filter { $0 != JS.quote }) + "\""
    }

    /// Replace the active mention with `path`. A file gets a trailing space so typing carries on; a
    /// directory ("src/") doesn't, so the autocomplete keeps going inside it.
    public static func insertMention(_ text: String, mention: ActiveMention, path: String) -> TextInsertion {
        let t = JS.units(text)
        let dir = JS.units(path).last == JS.slash
        var token = JS.units(formatMention(path))
        // A quoted directory stays open so the next segment lands inside the quotes.
        if dir && token.last == JS.quote { token.removeLast() }
        let after = JS.slice(t, mention.end)
        let space: [UInt16] = dir || after.first.map(JS.isSpace) == true ? [] : [JS.space]
        let next = Array(JS.slice(t, 0, mention.start)) + token + space + Array(after)
        // After a file, the caret skips the space (inserted or already there).
        return TextInsertion(text: JS.string(next), caret: mention.start + token.count + (dir ? 0 : 1))
    }

    /// Every path mentioned in `text`, in order, without duplicates.
    public static func parseMentions(_ text: String) -> [String] {
        // /@(?:"([^"\n]+)"|([^\s"]+))/g, scanned by hand on code units.
        let t = JS.units(text)
        var out: [[UInt16]] = []
        var pos = 0
        while let at = t[pos...].firstIndex(of: JS.at) {
            var path: [UInt16]
            if at + 1 < t.count, t[at + 1] == JS.quote,
               let close = t[(at + 2)...].firstIndex(where: { $0 == JS.quote || $0 == JS.newline }),
               t[close] == JS.quote, close > at + 2 {
                path = Array(t[(at + 2)..<close])
                pos = close + 1
            } else {
                var j = at + 1
                while j < t.count && !JS.isSpace(t[j]) && t[j] != JS.quote { j += 1 }
                guard j > at + 1 else {
                    pos = at + 1
                    continue
                }
                path = Array(t[(at + 1)..<j])
                pos = j
                // TRAILING: punctuation that ends a sentence rather than a path ("look at @src/a.ts.")
                while let last = path.last, trailing.contains(last) { path.removeLast() }
            }
            if !atBoundary(t, at) { continue }
            let trimmed = JS.units(JSCompat.trim(JS.string(path)))
            if !trimmed.isEmpty && !out.contains(trimmed) { out.append(trimmed) }
        }
        return out.map(JS.string)
    }

    /// Rank `paths` (files, and directories ending in "/") for the autocomplete, best first:
    /// the path starts with the query, then its name does, then any folder name in it does, then it
    /// contains the query. Only when none of those match do paths with the query's characters in
    /// order ("fmt" → format.ts) count. Case-insensitive; shorter paths win ties, after `demote`d
    /// ones (the file browser's gitignored paths) are put behind the rest of their rank. An empty
    /// query lists the top level.
    public static func rankPaths(_ paths: [String], query: String, limit: Int = 50, demote: ((String) -> Bool)? = nil) -> [String] {
        let q = JS.units(JS.lowercase(query))
        var scored: [(path: String, units: [UInt16], score: Int)] = []
        for path in paths {
            let lower = JS.units(JS.lowercase(path))
            // A picked folder ("src/") lists what's in it, not itself again. A file typed in full stays.
            if q.last == JS.slash && lower == q { continue }
            let units = JS.units(path)
            let score = q.isEmpty ? (topLevel(units) ? 0 : -1) : matchScore(lower, q)
            if score >= 0 { scored.append((path, units, score * 2 + (demote?(path) == true ? 1 : 0))) }
        }
        // Loose in-order matches are noise next to real ones (every path with m…e…n…t in it).
        let real = scored.filter { $0.score < loose * 2 }
        var kept = real.isEmpty ? scored : real
        kept.sort { a, b in
            if a.score != b.score { return a.score < b.score }
            if a.units.count != b.units.count { return a.units.count < b.units.count }
            return a.units.lexicographicallyPrecedes(b.units)
        }
        return JS.slice(kept, 0, limit).map(\.path)
    }

    // MARK: Helpers

    private static let loose = 4

    /// An @ only starts a mention at the start of the text, after whitespace, or after an opening
    /// bracket or quote, so `mark@example.com` and `a@b` aren't mentions.
    private static func atBoundary(_ t: [UInt16], _ at: Int) -> Bool {
        at == 0 || JS.isSpace(t[at - 1]) || boundary.contains(t[at - 1])
    }

    private static let boundary = Set("([{\"'`".utf16)
    private static let trailing = Set(".,;:!?)]}'\"`".utf16)

    private static func topLevel(_ path: [UInt16]) -> Bool {
        guard let slash = path.firstIndex(of: JS.slash) else { return true }
        return slash == path.count - 1
    }

    private static func matchScore(_ path: [UInt16], _ q: [UInt16]) -> Int {
        if path.starts(with: q) { return 0 }
        let trimmed = path.last == JS.slash ? path.dropLast() : path[...]
        let segments = trimmed.split(separator: JS.slash, omittingEmptySubsequences: false)
        if segments.last!.starts(with: q) { return 1 }
        if segments.contains(where: { $0.starts(with: q) }) { return 2 }
        if JS.contains(path, q) { return 3 }
        // `for (const ch of path) if (ch === q[i] …)`: ch is a code point, q[i] a code unit, so an
        // astral character never matches.
        var i = 0
        for scalar in JS.string(path).unicodeScalars {
            let units = Array(String(scalar).utf16)
            if units.count == 1 && units[0] == q[i] {
                i += 1
                if i == q.count { return loose }
            }
        }
        return -1
    }

    /// JavaScript string semantics on UTF-16 code units, shared by the composer ports (Mentions,
    /// Commands, MentionCaret, Templates, Prompts).
    enum JS {
        static let at = UInt16(UInt8(ascii: "@"))
        static let quote = UInt16(UInt8(ascii: "\""))
        static let newline = UInt16(UInt8(ascii: "\n"))
        static let slash = UInt16(UInt8(ascii: "/"))
        static let space = UInt16(UInt8(ascii: " "))

        static func units(_ s: String) -> [UInt16] { Array(s.utf16) }

        static func string(_ u: some Collection<UInt16>) -> String { String(decoding: u, as: UTF16.self) }

        /// Regex `\s` on one code unit (every JS whitespace character is in the BMP).
        static func isSpace(_ u: UInt16) -> Bool {
            Unicode.Scalar(u).map(JSCompat.isWhitespace) ?? false
        }

        /// `String.prototype.indexOf` for one code unit, from `from`; -1 when absent.
        static func indexOf(_ t: [UInt16], _ c: UInt16, from: Int) -> Int {
            let start = max(0, from)
            guard start < t.count else { return -1 }
            return t[start...].firstIndex(of: c) ?? -1
        }

        /// `String.prototype.includes` on code units.
        static func contains(_ t: [UInt16], _ q: [UInt16]) -> Bool {
            if q.isEmpty { return true }
            if q.count > t.count { return false }
            for i in 0...(t.count - q.count) where t[i] == q[0] && t[i..<(i + q.count)].elementsEqual(q) { return true }
            return false
        }

        /// `Array.prototype.slice` / `String.prototype.slice`: negative indices count from the end,
        /// everything clamps.
        static func slice<T>(_ a: [T], _ start: Int, _ end: Int? = nil) -> ArraySlice<T> {
            func clamp(_ i: Int) -> Int { i < 0 ? max(0, a.count + i) : min(i, a.count) }
            let s = clamp(start)
            let e = clamp(end ?? a.count)
            return s < e ? a[s..<e] : []
        }

        /// Code-unit equality (`===`). Swift's String == equates canonically equivalent strings.
        static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

        /// `String.prototype.toLowerCase`: the full Unicode lower-case mapping, with the one
        /// context-sensitive rule JS applies, Final_Sigma (Σ at the end of a word → ς).
        static func lowercase(_ s: String) -> String {
            let scalars = Array(s.unicodeScalars)
            var out = String.UnicodeScalarView()
            for (i, c) in scalars.enumerated() {
                if c == "\u{03A3}" && finalSigma(scalars, i) {
                    out.append("\u{03C2}")
                } else {
                    out.append(contentsOf: c.properties.lowercaseMapping.unicodeScalars)
                }
            }
            return String(out)
        }

        private static func finalSigma(_ s: [Unicode.Scalar], _ i: Int) -> Bool {
            var j = i - 1
            while j >= 0 && s[j].properties.isCaseIgnorable { j -= 1 }
            guard j >= 0 && s[j].properties.isCased else { return false }
            j = i + 1
            while j < s.count && s[j].properties.isCaseIgnorable { j += 1 }
            return !(j < s.count && s[j].properties.isCased)
        }
    }
}
