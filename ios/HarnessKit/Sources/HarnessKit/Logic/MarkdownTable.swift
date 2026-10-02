import Foundation

// Table layout for rendered markdown. Each column is as wide as
// its widest cell, capped so one long cell wraps instead of stretching the table; each row is as
// tall as its tallest cell once wrapped to those widths. The app's table Layout measures the cells
// and asks these for the grid.

public enum MarkdownTable {
    /// The widest a column gets (points, cell padding included).
    public static let maxColumnWidth: Double = 240

    /// Column widths from each cell's natural (unwrapped) width, `natural[row][column]`, header row
    /// included: `min(cap, ceil(widest) + 1)`. Rows shorter than
    /// `columns` count as empty there; a column nothing measured is 0 wide.
    public static func columnWidths(_ natural: [[Double]], columns: Int, cap: Double = maxColumnWidth) -> [Double] {
        (0..<max(0, columns)).map { j in
            let widest = natural.reduce(0.0) { m, row in j < row.count && row[j].isFinite ? max(m, row[j]) : m }
            return widest > 0 ? min(cap, widest.rounded(.up) + 1) : 0
        }
    }

    /// Row heights: the tallest cell in each row, `heights[row][column]` measured at the column widths.
    public static func rowHeights(_ heights: [[Double]]) -> [Double] {
        heights.map { row in row.reduce(0.0) { $1.isFinite ? max($0, $1.rounded(.up)) : $0 } }
    }

    /// Whether markdown has a block that scrolls sideways (a table or fenced code), so it needs a
    /// container with a definite width.
    public static func scrollsSideways(_ text: String) -> Bool {
        scrollsSideways(Markdown.parseBlocks(text))
    }

    public static func scrollsSideways(_ blocks: [Markdown.Block]) -> Bool {
        blocks.contains {
            switch $0 {
            case .table, .code: true
            default: false
            }
        }
    }
}
