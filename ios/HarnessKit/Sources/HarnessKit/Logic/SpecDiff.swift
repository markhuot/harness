import Foundation

// Port of shared/src/state/specDiff.ts: the Spec tab's Show changes, as rendered markdown. Two
// revisions of a spec are parsed with Markdown.parseBlocks/inlineTokens and compared block by block
// and word by word, so turning changes on keeps headings, lists, tables and code where they were,
// with added words marked green and removed ones red. The TS file's header spells out the
// algorithm; shared/fixtures/cases/specDiff.ts pins the output this port must reproduce exactly.
//
// Equality is the TS one: JSON.stringify keys and `===` strings compare code units, so keys here
// are UTF-8 bytes (never Swift's canonically-equivalent String ==), and text splits on scalars.

public enum MarkdownDiff {
    /// Whether a piece of the newer revision is in both, only in the newer one, or only in the older one.
    public enum Change: String, Codable, Sendable {
        case same, add, del
    }

    /// An inline token carrying its change, encoded like the TS `InlineToken & { change }`.
    /// Text-bearing tokens may hold part of the original token's text.
    public struct Run: Encodable, Equatable, Sendable {
        public var token: Markdown.InlineToken
        public var change: Change

        public init(_ token: Markdown.InlineToken, _ change: Change) {
            self.token = token
            self.change = change
        }

        private enum CodingKeys: String, CodingKey { case change }

        public func encode(to encoder: Encoder) throws {
            try token.encode(to: encoder)
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(change, forKey: .change)
        }
    }

    /// A line of a code block.
    public struct CodeLine: Encodable, Equatable, Sendable {
        public var change: Change
        public var text: String
    }

    /// A list item: unchanged, added or removed as parsed, or edited (its text or nested lists
    /// changed) with its text as runs and its nested lists as diffed blocks.
    public enum Item: Encodable, Equatable, Sendable {
        case plain(Change, Markdown.ListItem)
        case edit(runs: [Run], children: [DiffBlock])

        private enum CodingKeys: String, CodingKey { case change, item, runs, children }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .plain(change, item):
                try c.encode(change, forKey: .change)
                try c.encode(item, forKey: .item)
            case let .edit(runs, children):
                try c.encode("edit", forKey: .change)
                try c.encode(runs, forKey: .runs)
                try c.encode(children, forKey: .children)
            }
        }
    }

    /// A table body row: the cells as parsed, or (edited) each cell as runs.
    public enum Row: Encodable, Equatable, Sendable {
        case plain(Change, [String])
        case edit([[Run]])

        private enum CodingKeys: String, CodingKey { case change, cells }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .plain(change, cells):
                try c.encode(change, forKey: .change)
                try c.encode(cells, forKey: .cells)
            case let .edit(cells):
                try c.encode("edit", forKey: .change)
                try c.encode(cells, forKey: .cells)
            }
        }
    }

    /// A block of the newer revision whose contents changed, shaped like the Block it renders as.
    /// Lists and ol `start` are the newer revision's.
    public indirect enum EditBlock: Encodable, Equatable, Sendable {
        case p(runs: [Run])
        case quote(runs: [Run])
        case h(level: Int, runs: [Run])
        case ul(items: [Item])
        case ol(start: Int, items: [Item])
        case code(lang: String, lines: [CodeLine])
        case table(align: [Markdown.Align?], header: [[Run]], rows: [Row])

        private enum CodingKeys: String, CodingKey { case t, runs, level, items, start, lang, lines, align, header, rows }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .p(runs):
                try c.encode("p", forKey: .t)
                try c.encode(runs, forKey: .runs)
            case let .quote(runs):
                try c.encode("quote", forKey: .t)
                try c.encode(runs, forKey: .runs)
            case let .h(level, runs):
                try c.encode("h", forKey: .t)
                try c.encode(level, forKey: .level)
                try c.encode(runs, forKey: .runs)
            case let .ul(items):
                try c.encode("ul", forKey: .t)
                try c.encode(items, forKey: .items)
            case let .ol(start, items):
                try c.encode("ol", forKey: .t)
                try c.encode(start, forKey: .start)
                try c.encode(items, forKey: .items)
            case let .code(lang, lines):
                try c.encode("code", forKey: .t)
                try c.encode(lang, forKey: .lang)
                try c.encode(lines, forKey: .lines)
            case let .table(align, header, rows):
                try c.encode("table", forKey: .t)
                try c.encode(align, forKey: .align)
                try c.encode(header, forKey: .header)
                try c.encode(rows, forKey: .rows)
            }
        }
    }

    /// One block of the compared document, in reading order: unchanged, only in the newer revision,
    /// only in the older one (`plain`), or in both with changes (`edit`).
    public indirect enum DiffBlock: Encodable, Equatable, Sendable {
        case plain(Change, Markdown.Block)
        case edit(EditBlock)

        private enum CodingKeys: String, CodingKey { case change, block }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .plain(change, block):
                try c.encode(change, forKey: .change)
                try c.encode(block, forKey: .block)
            case let .edit(block):
                try c.encode("edit", forKey: .change)
                try c.encode(block, forKey: .block)
            }
        }
    }

    /// The minimum Dice coefficient of shared words for two texts to be shown as one edited block.
    public static let similarThreshold = 0.4

    /// Compare two revisions of a spec (older first) for rendering with their changes marked.
    public static func specDiff(_ before: String, _ after: String) -> [DiffBlock] {
        diffBlocks(Markdown.parseBlocks(before), Markdown.parseBlocks(after))
    }

    /// True when the comparison found nothing changed.
    public static func unchanged(_ blocks: [DiffBlock]) -> Bool {
        blocks.allSatisfy { if case .plain(.same, _) = $0 { true } else { false } }
    }

    /// The attachments a diff shows, for the viewer to page through: the newer revision's, then the
    /// older one's that it dropped, once per id.
    public static func media(_ before: String, _ after: String) -> [Markdown.Media] {
        var seen = Set<String>()
        return (Markdown.mediaIn(Markdown.parseBlocks(after)) + Markdown.mediaIn(Markdown.parseBlocks(before))).filter { seen.insert($0.id).inserted }
    }

    // MARK: Alignment

    private enum Op {
        case same(Int, Int)
        case del(Int)
        case add(Int)
    }

    /// Step 1: the edit script turning `a` into `b`, by key (keys compare as bytes).
    private static func lcs<T>(_ a: [T], _ b: [T], key: (T) -> Data) -> [Op] {
        var ids: [Data: Int] = [:]
        func id(_ d: Data) -> Int {
            if let i = ids[d] { return i }
            let i = ids.count
            ids[d] = i
            return i
        }
        let ka = a.map { id(key($0)) }
        let kb = b.map { id(key($0)) }
        var pre = 0
        while pre < ka.count, pre < kb.count, ka[pre] == kb[pre] { pre += 1 }
        var suf = 0
        while suf < ka.count - pre, suf < kb.count - pre, ka[ka.count - 1 - suf] == kb[kb.count - 1 - suf] { suf += 1 }
        let n = ka.count - pre - suf
        let m = kb.count - pre - suf
        // L[i][j], flattened: the LCS of a[pre+i…] and b[pre+j…].
        let w = m + 1
        var L = [Int](repeating: 0, count: (n + 1) * w)
        if n > 0, m > 0 {
            for i in stride(from: n - 1, through: 0, by: -1) {
                for j in stride(from: m - 1, through: 0, by: -1) {
                    L[i * w + j] = ka[pre + i] == kb[pre + j] ? L[(i + 1) * w + j + 1] + 1 : max(L[(i + 1) * w + j], L[i * w + j + 1])
                }
            }
        }
        var ops: [Op] = (0..<pre).map { .same($0, $0) }
        var i = 0, j = 0
        while i < n || j < m {
            if i < n, j < m, ka[pre + i] == kb[pre + j] {
                ops.append(.same(pre + i, pre + j))
                i += 1
                j += 1
            } else if i < n, j >= m || L[(i + 1) * w + j] >= L[i * w + j + 1] {
                ops.append(.del(pre + i))
                i += 1
            } else {
                ops.append(.add(pre + j))
                j += 1
            }
        }
        for k in 0..<suf { ops.append(.same(ka.count - suf + k, kb.count - suf + k)) }
        return ops
    }

    private enum Out<T, R> {
        case same(T, T)
        case del(T)
        case add(T)
        case pair(T, T, R)
    }

    /// Steps 1-2: align `a` with `b`, pairing deleted and added elements in each gap when `pair`
    /// returns a result for them (nil: they can't pair).
    private static func align<T, R>(_ a: [T], _ b: [T], key: (T) -> Data, pair: (T, T) -> R?) -> [Out<T, R>] {
        var out: [Out<T, R>] = []
        var dels: [T] = []
        var adds: [T] = []
        func flush() {
            var j = 0
            for d in dels {
                var found: (Int, R)?
                for k in j..<adds.count {
                    if let r = pair(d, adds[k]) {
                        found = (k, r)
                        break
                    }
                }
                guard let (k, r) = found else {
                    out.append(.del(d))
                    continue
                }
                while j < k {
                    out.append(.add(adds[j]))
                    j += 1
                }
                out.append(.pair(d, adds[k], r))
                j = k + 1
            }
            while j < adds.count {
                out.append(.add(adds[j]))
                j += 1
            }
            dels = []
            adds = []
        }
        for op in lcs(a, b, key: key) {
            switch op {
            case let .del(i): dels.append(a[i])
            case let .add(j): adds.append(b[j])
            case let .same(i, j):
                flush()
                out.append(.same(a[i], b[j]))
            }
        }
        flush()
        return out
    }

    /// `JSON.stringify(x)` as an equality key: any deterministic encoding of the same structure.
    private static func json(_ value: some Encodable) -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return (try? e.encode(value)) ?? Data()
    }

    // MARK: Words

    /// A ticket or img token, which stays whole and never merges.
    private static func whole(_ t: Markdown.InlineToken) -> Bool {
        switch t {
        case .ticket, .img: true
        default: false
        }
    }

    /// A text-bearing token's text.
    private static func text(_ t: Markdown.InlineToken) -> String {
        switch t {
        case let .text(s), let .code(s), let .strong(s), let .em(s), let .link(s, _): s
        case .ticket, .img: ""
        }
    }

    /// The same text-bearing token holding `s`.
    private static func with(_ t: Markdown.InlineToken, text s: String) -> Markdown.InlineToken {
        switch t {
        case .text: .text(s)
        case .code: .code(s)
        case .strong: .strong(s)
        case .em: .em(s)
        case let .link(_, url): .link(text: s, url: url)
        case .ticket, .img: t
        }
    }

    private static func styleKey(_ t: Markdown.InlineToken) -> String {
        switch t {
        case .text: "text"
        case .code: "code"
        case .strong: "strong"
        case .em: "em"
        case let .link(_, url): "link \(url)"
        case .ticket: "ticket"
        case .img: "img"
        }
    }

    private static func unitKey(_ u: Markdown.InlineToken) -> Data {
        whole(u) ? json(u) : Data("\(styleKey(u))|\(text(u))".utf8)
    }

    /// `/^\s+$/` on a text-bearing unit.
    private static func isSpace(_ u: Markdown.InlineToken) -> Bool {
        guard !whole(u) else { return false }
        let s = text(u).unicodeScalars
        return !s.isEmpty && s.allSatisfy(JSCompat.isWhitespace)
    }

    /// `s.match(/\n|[^\S\n]+|\S+/g) ?? []`
    private static func pieces(_ s: String) -> [String] {
        var out: [String] = []
        var cur = String.UnicodeScalarView()
        var curSpace = false
        for u in s.unicodeScalars {
            let space = JSCompat.isWhitespace(u)
            if u == "\n" || cur.isEmpty || space != curSpace || cur.first == "\n" {
                if !cur.isEmpty { out.append(String(cur)) }
                cur = String.UnicodeScalarView()
                curSpace = space
            }
            cur.append(u)
        }
        if !cur.isEmpty { out.append(String(cur)) }
        return out
    }

    /// `s.split("\n")`, on scalars.
    private static func lines(_ s: String) -> [String] {
        s.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map { String(String.UnicodeScalarView($0)) }
    }

    /// The units of a paragraph, heading, quote, item or cell: each line's tokens, "\n" between lines.
    private static func units(_ text: String) -> [Markdown.InlineToken] {
        var out: [Markdown.InlineToken] = []
        for (i, line) in lines(text).enumerated() {
            if i > 0 { out.append(.text("\n")) }
            for tok in Markdown.inlineTokens(line) {
                if whole(tok) { out.append(tok) } else { out += pieces(Self.text(tok)).map { with(tok, text: $0) } }
            }
        }
        return out
    }

    /// Step 4: whether two texts share enough words to show as one edited block.
    private static func similar(_ a: String, _ b: String) -> Bool {
        let ua = units(a).filter { !isSpace($0) }
        let ub = units(b).filter { !isSpace($0) }
        if ua.isEmpty && ub.isEmpty { return true }
        let common = lcs(ua, ub, key: unitKey).filter { if case .same = $0 { true } else { false } }.count
        return Double(2 * common) / Double(ua.count + ub.count) >= similarThreshold
    }

    private static func merge(_ list: [Run]) -> [Run] {
        var out: [Run] = []
        for r in list {
            if let prev = out.last, prev.change == r.change, !whole(r.token), !whole(prev.token), styleKey(prev.token) == styleKey(r.token) {
                out[out.count - 1].token = with(prev.token, text: text(prev.token) + text(r.token))
            } else {
                out.append(r)
            }
        }
        return out
    }

    /// Step 5: a paired text as runs.
    public static func diffText(_ a: String, _ b: String) -> [Run] {
        let ua = units(a)
        let ub = units(b)
        let list: [Run] = lcs(ua, ub, key: unitKey).map { op -> Run in
            switch op {
            case let .same(_, j): Run(ub[j], .same)
            case let .del(i): Run(ua[i], .del)
            case let .add(j): Run(ub[j], .add)
            }
        }
        // Whitespace-only "same" stretches between changes join the change.
        var spread: [Run] = []
        var i = 0
        while i < list.count {
            var k = i
            while k < list.count, list[k].change == .same { k += 1 }
            let stretch = list[i..<k]
            if !stretch.isEmpty, i > 0, k < list.count, stretch.allSatisfy({ isSpace($0.token) }) {
                for s in stretch { spread += [Run(s.token, .del), Run(s.token, .add)] }
            } else {
                spread += stretch
            }
            if k < list.count { spread.append(list[k]) }
            i = k + 1
        }
        // Within each stretch of changes, deletions first.
        var ordered: [Run] = []
        i = 0
        while i < spread.count {
            if spread[i].change == .same {
                ordered.append(spread[i])
                i += 1
                continue
            }
            var k = i
            while k < spread.count, spread[k].change != .same { k += 1 }
            let stretch = spread[i..<k]
            ordered += stretch.filter { $0.change == .del } + stretch.filter { $0.change == .add }
            i = k
        }
        return merge(ordered)
    }

    // MARK: Blocks

    private static func diffItems(_ a: [Markdown.ListItem], _ b: [Markdown.ListItem]) -> [Item] {
        align(a, b, key: json, pair: { x, y in similar(x.text, y.text) ? true : nil }).map { o -> Item in
            switch o {
            case let .same(_, y): .plain(.same, y)
            case let .del(x): .plain(.del, x)
            case let .add(y): .plain(.add, y)
            case let .pair(x, y, _): .edit(runs: diffText(x.text, y.text), children: diffBlocks(x.children, y.children))
            }
        }
    }

    private static func diffRows(_ a: [[String]], _ b: [[String]]) -> [Row] {
        align(a, b, key: json, pair: { x, y in similar(x.joined(separator: " "), y.joined(separator: " ")) ? true : nil }).map { o -> Row in
            switch o {
            case let .same(_, y): .plain(.same, y)
            case let .del(x): .plain(.del, x)
            case let .add(y): .plain(.add, y)
            case let .pair(x, y, _): .edit(y.enumerated().map { k, cell in diffText(k < x.count ? x[k] : "", cell) })
            }
        }
    }

    /// Step 3: an edited block for two differing blocks that may pair, else nil.
    private static func pairBlocks(_ a: Markdown.Block, _ b: Markdown.Block) -> EditBlock? {
        switch (a, b) {
        case let (.p(x), .p(y)):
            return similar(x, y) ? .p(runs: diffText(x, y)) : nil
        case let (.quote(x), .quote(y)):
            return similar(x, y) ? .quote(runs: diffText(x, y)) : nil
        case let (.h(la, x), .h(lb, y)):
            return la == lb && similar(x, y) ? .h(level: lb, runs: diffText(x, y)) : nil
        case let (.ul(x), .ul(y)):
            return .ul(items: diffItems(x, y))
        case let (.ol(_, x), .ol(start, y)):
            return .ol(start: start, items: diffItems(x, y))
        case let (.code(langA, x), .code(langB, y)):
            guard langA.unicodeScalars.elementsEqual(langB.unicodeScalars) else { return nil }
            let la = lines(x)
            let lb = lines(y)
            return .code(lang: langB, lines: lcs(la, lb, key: { Data($0.utf8) }).map { op -> CodeLine in
                switch op {
                case let .add(j): CodeLine(change: .add, text: lb[j])
                case let .del(i): CodeLine(change: .del, text: la[i])
                case let .same(_, j): CodeLine(change: .same, text: lb[j])
                }
            })
        case let (.table(alignA, headerA, rowsA), .table(alignB, headerB, rowsB)):
            guard alignA == alignB else { return nil }
            return .table(align: alignB, header: headerB.enumerated().map { k, cell in diffText(k < headerA.count ? headerA[k] : "", cell) },
                          rows: diffRows(rowsA, rowsB))
        default:
            return nil
        }
    }

    /// Steps 1-3 over two block lists.
    public static func diffBlocks(_ a: [Markdown.Block], _ b: [Markdown.Block]) -> [DiffBlock] {
        align(a, b, key: json, pair: pairBlocks).map { o -> DiffBlock in
            switch o {
            case let .same(_, y): .plain(.same, y)
            case let .del(x): .plain(.del, x)
            case let .add(y): .plain(.add, y)
            case let .pair(_, _, r): .edit(r)
            }
        }
    }
}
