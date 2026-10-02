import HarnessKit
import SwiftUI

/// Agent markdown (ui/Markdown.tsx): blocks and inline tokens come from HarnessKit's port of the
/// shared parser; web links open in Safari, file links in the file viewer (ContentLinks), ticket
/// keys open the ticket, and wide tables scroll sideways. Fenced code is syntax highlighted
/// (CodeBlockView). Nothing is ever interpreted as markup.
///
/// `size` is the body text size; `color` overrides the text color (nil = palette text). File links
/// resolve against `linkContext` when it names a ticket or project, else the nearest
/// `.fileLinkScope(…)`.
struct MarkdownView: View {
    let text: String
    var size: CGFloat = 15
    var color: Color?
    /// Where relative file links open (the ticket's folder, else the project's).
    var linkContext = FileLinkContext()

    @Environment(\.palette) private var c
    @Environment(BoardStore.self) private var store: BoardStore?

    /// Whether `text` has a block that scrolls sideways (a table or fenced code). Such markdown needs
    /// a container with a definite width rather than a shrink-to-fit bubble.
    static func scrollsSideways(_ text: String) -> Bool {
        MarkdownTable.scrollsSideways(MarkdownCache.shared.blocks(text))
    }

    var body: some View {
        let blocks = MarkdownCache.shared.blocks(text)
        let style = MarkdownStyle(size: size, color: color ?? c.text, palette: c, linkable: linkable)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks.indices, id: \.self) { i in
                MarkdownBlockView(block: blocks[i], style: style)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tint(c.accentText)
        .modifier(ContentLinkHandling(override: linkContext))
    }

    /// A ticket key links when the store can resolve it (or it's in a project's key space);
    /// look-alikes such as UTF-8 stay text. Without a store nothing links.
    private var linkable: (String) -> Bool {
        guard let store else { return { _ in false } }
        return { store.state.ticketLinkable($0) }
    }
}

/// What every block draws with.
@MainActor
struct MarkdownStyle {
    let size: CGFloat
    let color: Color
    let palette: Palette
    let linkable: (String) -> Bool

    var font: Font { .scaled(size: size) }
    /// RN lineHeight round(size × 1.45), as extra spacing over the font's own line height.
    var lineSpacing: CGFloat { (size * 1.45).rounded() - size * 1.2 }

    /// Inline tokens as one AttributedString: code spans in mono on bgActive, bold, italic, links
    /// and linkable ticket keys (both in the tint, accentText).
    func inline(_ text: String, size: CGFloat? = nil, bold: Bool = false) -> AttributedString {
        let size = size ?? self.size
        let base = Font.scaled(size: size, weight: bold ? .bold : .regular)
        var out = AttributedString()
        for token in MarkdownCache.shared.inline(text) {
            var run: AttributedString
            switch token {
            case let .text(s):
                run = AttributedString(s)
                run.font = base
            case let .code(s):
                run = AttributedString(" \(s) ")
                run.font = .mono(13)
                run.backgroundColor = palette.bgActive
                run.foregroundColor = palette.text
            case let .strong(s):
                run = AttributedString(s)
                run.font = .scaled(size: size, weight: .bold)
            case let .em(s):
                run = AttributedString(s)
                run.font = base.italic()
            case let .link(text, url):
                run = AttributedString(text)
                run.font = base
                run.link = ContentLinkURL.link(url)
            case let .ticket(key):
                run = AttributedString(key)
                run.font = base
                if linkable(key) { run.link = ContentLinkURL.ticket(key) }
            }
            out.append(run)
        }
        return out
    }
}

/// Parsed blocks and inline tokens by source text, so a long transcript re-renders without
/// re-parsing every message. Bounded; the oldest entries go first.
@MainActor
final class MarkdownCache {
    static let shared = MarkdownCache()

    private var blocks = Bounded<[Markdown.Block]>(capacity: 400)
    private var inlines = Bounded<[Markdown.InlineToken]>(capacity: 2000)

    func blocks(_ text: String) -> [Markdown.Block] {
        blocks.value(text) { Markdown.parseBlocks($0) }
    }

    func inline(_ text: String) -> [Markdown.InlineToken] {
        inlines.value(text) { Markdown.inlineTokens($0) }
    }

    private struct Bounded<V> {
        let capacity: Int
        var entries: [String: V] = [:]
        var order: [String] = []

        mutating func value(_ key: String, make: (String) -> V) -> V {
            if let v = entries[key] { return v }
            let v = make(key)
            entries[key] = v
            order.append(key)
            if order.count > capacity {
                let drop = order.count - capacity * 3 / 4
                for k in order.prefix(drop) { entries[k] = nil }
                order.removeFirst(drop)
            }
            return v
        }
    }
}

private struct MarkdownBlockView: View {
    let block: Markdown.Block
    let style: MarkdownStyle

    private var c: Palette { style.palette }

    var body: some View {
        switch block {
        case let .p(text):
            paragraph(style.inline(text))
        case let .h(level, text):
            paragraph(style.inline(text, size: level <= 2 ? style.size + 2 : style.size + 0.5, bold: true))
                .padding(.top, 2)
        case let .ul(items):
            list(items, ordered: false)
        case let .ol(items):
            list(items, ordered: true)
        case let .code(lang, text):
            CodeBlockView(code: text, language: lang)
        case let .quote(text):
            paragraph(style.inline(text), color: c.text2)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(c.borderStrong).frame(width: 3)
                }
        case let .table(align, header, rows):
            MarkdownTableView(align: align, header: header, rows: rows, style: style)
        case .hr:
            HairlineRule(color: c.border).padding(.vertical, 4)
        }
    }

    private func paragraph(_ s: AttributedString, color: Color? = nil) -> some View {
        Text(s)
            .foregroundStyle(color ?? style.color)
            .lineSpacing(style.lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    private func list(_ items: [String], ordered: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items.indices, id: \.self) { j in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(ordered ? "\(j + 1)." : "•")
                        .font(style.font)
                        .foregroundStyle(c.text3)
                        .frame(minWidth: ordered ? 18 : 10, alignment: .trailing)
                        .accessibilityHidden(!ordered)
                    paragraph(style.inline(items[j]))
                }
                .padding(.trailing, 4)
            }
        }
    }
}

/// A one-pixel line (StyleSheet.hairlineWidth).
struct HairlineRule: View {
    let color: Color
    var vertical = false
    @Environment(\.displayScale) private var scale

    var body: some View {
        Rectangle().fill(color)
            .frame(width: vertical ? 1 / scale : nil, height: vertical ? nil : 1 / scale)
    }
}

/// A GFM table: columns as wide as their widest cell up to MarkdownTable.maxColumnWidth (longer
/// cells wrap), rows as tall as their tallest cell, scrolling sideways when wider than the screen.
private struct MarkdownTableView: View {
    let align: [Markdown.Align?]
    let header: [String]
    let rows: [[String]]
    let style: MarkdownStyle

    @Environment(\.displayScale) private var scale
    private var c: Palette { style.palette }

    var body: some View {
        let all = [header] + rows
        let columns = header.count
        ScrollView(.horizontal) {
            MarkdownTableLayout(columns: columns) {
                ForEach(all.indices, id: \.self) { r in
                    ForEach(0..<columns, id: \.self) { j in
                        cell(j < all[r].count ? all[r][j] : "", row: r, column: j, last: r == all.count - 1)
                    }
                }
            }
            .clipShape(.rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border, lineWidth: 1 / scale))
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    private func cell(_ text: String, row: Int, column j: Int, last: Bool) -> some View {
        let fontSize = style.size - 1.5
        let a = j < align.count ? align[j] : nil
        return Text(style.inline(text, size: fontSize, bold: row == 0))
            .foregroundStyle(style.color)
            .lineSpacing((fontSize * 1.4).rounded() - fontSize * 1.2)
            .multilineTextAlignment(a == .center ? .center : a == .right ? .trailing : .leading)
            .textSelection(.enabled)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: a == .center ? .top : a == .right ? .topTrailing : .topLeading)
            .background(row == 0 ? c.bgSunken : .clear, in: .rect)
            .overlay(alignment: .leading) { if j > 0 { HairlineRule(color: c.border, vertical: true) } }
            .overlay(alignment: .bottom) { if !last { HairlineRule(color: c.border) } }
    }
}

/// Lays out `columns` × n cells (row-major) on MarkdownTable's grid.
struct MarkdownTableLayout: Layout {
    let columns: Int

    struct Grid {
        var widths: [CGFloat] = []
        var heights: [CGFloat] = []
    }

    func makeCache(subviews: Subviews) -> Grid { grid(subviews) }

    func updateCache(_ cache: inout Grid, subviews: Subviews) { cache = grid(subviews) }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Grid) -> CGSize {
        CGSize(width: cache.widths.reduce(0, +), height: cache.heights.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Grid) {
        guard columns > 0 else { return }
        var y = bounds.minY
        for (r, h) in cache.heights.enumerated() {
            var x = bounds.minX
            for (j, w) in cache.widths.enumerated() {
                let i = r * columns + j
                guard i < subviews.count else { return }
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: w, height: h))
                x += w
            }
            y += h
        }
    }

    private func grid(_ subviews: Subviews) -> Grid {
        guard columns > 0 else { return Grid() }
        let rows = subviews.count / columns
        let cells = (0..<rows).map { r in (0..<columns).map { subviews[r * columns + $0] } }
        let natural = cells.map { $0.map { Double($0.sizeThatFits(.unspecified).width) } }
        let widths = MarkdownTable.columnWidths(natural, columns: columns)
        let heights = MarkdownTable.rowHeights(cells.map { row in
            row.enumerated().map { j, cell in Double(cell.sizeThatFits(ProposedViewSize(width: widths[j], height: nil)).height) }
        })
        return Grid(widths: widths.map { CGFloat($0) }, heights: heights.map { CGFloat($0) })
    }
}
