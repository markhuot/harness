import SwiftUI

/// Lays its children out in rows, wrapping onto as many as they need (RN `flexWrap: "wrap"`).
/// `spacing` is the gap between children in a row, `lineSpacing` the gap between rows (default:
/// `spacing`). `alignment` places each row: leading, or trailing for a value column. Children are
/// centered vertically in their row. A child wider than the row (a long branch name) is offered
/// the row's width, so it truncates instead of overflowing. A child that draws nothing (zero size,
/// e.g. a badge with no value) takes no slot, so it adds no gap. The layout is as wide as its
/// widest row, never wider than it's offered.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat?
    var alignment: HorizontalAlignment = .leading

    private var rowGap: CGFloat { lineSpacing ?? spacing }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + rowGap * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: min(proposal.width ?? width, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(width: bounds.width, subviews: subviews)
        var placed = Set<Int>()
        var y = bounds.minY
        for row in rows {
            var x = alignment == .trailing ? bounds.maxX - row.width : bounds.minX
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: x, y: y + (row.height - item.size.height) / 2), proposal: ProposedViewSize(item.size))
                placed.insert(item.index)
                x += item.size.width + spacing
            }
            y += row.height + rowGap
        }
        // The empty ones still get a place, out of the way.
        for i in subviews.indices where !placed.contains(i) {
            subviews[i].place(at: bounds.origin, proposal: .zero)
        }
    }

    private struct Item {
        let index: Int
        let size: CGSize
    }

    private struct Row {
        var items: [Item] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for i in subviews.indices {
            let size = Self.size(of: subviews[i], width: width)
            if size.width == 0 && size.height == 0 { continue }
            let next = row.items.isEmpty ? size.width : row.width + spacing + size.width
            if next > width, !row.items.isEmpty {
                rows.append(row)
                row = Row()
            }
            row.width = row.items.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.items.append(Item(index: i, size: size))
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }

    /// Its natural size; a child wider than the row gets the row's width (and truncates).
    private static func size(of view: LayoutSubview, width: CGFloat) -> CGSize {
        let size = view.sizeThatFits(.unspecified)
        return size.width > width ? view.sizeThatFits(ProposedViewSize(width: width, height: nil)) : size
    }
}
