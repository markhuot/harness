import HarnessHighlight
import HarnessKit
import SwiftUI
import UIKit

// The file viewer's code list (FileViewer.tsx CodeList): fixed-height rows that never wrap, in one
// UICollectionView that scrolls both ways, so a 20 000-line file opens straight at its range and
// long lines scroll sideways together. SwiftUI's lazy stacks estimate row heights and re-measure
// as they go, which made jumping to a line deep in a big file land in the wrong place and stutter;
// a layout that knows every row is 19 pt does neither.

/// One column of a row: a line number, a diff sign, the code.
struct FileCodeColumn {
    var text: NSAttributedString
    /// Nil takes the rest of the row (the code).
    var width: CGFloat?
    var alignment: NSTextAlignment = .left
    var leading: CGFloat = 0
    var trailing: CGFloat = 0
    /// Line numbers and signs are left out of VoiceOver; the code says its line in its value.
    var accessibilityHidden = false
    var accessibilityValue: String?
}

struct FileCodeRow {
    var columns: [FileCodeColumn]
    var background: UIColor?
    /// The file body's range marker at the leading edge; 0 for none.
    var edgeWidth: CGFloat = 0
    var edgeColor: UIColor?
}

/// Sizes shared by the file and diff bodies (FileViewer.tsx ROW, PAD, CHAR).
enum FileCodeMetrics {
    static let row: CGFloat = 19
    static let pad: CGFloat = 10
    static let font = UIFont.monospacedSystemFont(ofSize: HighlightedText.fontSize, weight: .regular)
    static let boldFont = UIFont.monospacedSystemFont(ofSize: HighlightedText.fontSize, weight: .bold)
    static let semiboldFont = UIFont.monospacedSystemFont(ofSize: HighlightedText.fontSize, weight: .semibold)
    /// The monospaced face's advance width.
    static let char: CGFloat = ("0" as NSString).size(withAttributes: [.font: font]).width
    /// UTF-16 units of a line that are laid out: the widest drawn line plus a little, since
    /// anything past `maxColumns` is clipped anyway.
    static let maxUnits = FileViewerRules.maxColumns + 8
}

/// Token spans → NSAttributedString for the UIKit rows, styled as HighlightedText styles them.
@MainActor
final class FileCodeText {
    private var colors: [String: UIColor] = [:]

    func color(_ css: String) -> UIColor? {
        if let hit = colors[css] { return hit }
        guard let rgba = RGBA(css: css) else { return nil }
        let c = UIColor(rgba: rgba)
        colors[css] = c
        return c
    }

    /// Text in one color, tabs as 4 spaces, clipped past the widest line drawn.
    func plain(_ text: String, color: UIColor, font: UIFont = FileCodeMetrics.font) -> NSAttributedString {
        NSAttributedString(string: Self.clip(FileViewerRules.expandTabs(text), FileCodeMetrics.maxUnits), attributes: [.font: font, .foregroundColor: color])
    }

    /// Shiki spans in their colors (`fg` for uncolored ones), with italic, bold and underline.
    func spans(_ spans: some Collection<HighlightSpan>, fg: UIColor) -> NSAttributedString {
        let out = NSMutableAttributedString()
        var budget = FileCodeMetrics.maxUnits
        for span in spans where budget > 0 {
            let text = Self.clip(FileViewerRules.expandTabs(span.text), budget)
            budget -= text.utf16.count
            var attrs: [NSAttributedString.Key: Any] = [.font: Self.font(span), .foregroundColor: span.color.flatMap(color) ?? fg]
            if span.isUnderline { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
            out.append(NSAttributedString(string: text, attributes: attrs))
        }
        return out
    }

    private static let fonts: [Int: UIFont] = {
        var out: [Int: UIFont] = [:]
        for bits in 0..<4 {
            var f = bits & 2 != 0 ? FileCodeMetrics.boldFont : FileCodeMetrics.font
            if bits & 1 != 0, let d = f.fontDescriptor.withSymbolicTraits(f.fontDescriptor.symbolicTraits.union(.traitItalic)) {
                f = UIFont(descriptor: d, size: f.pointSize)
            }
            out[bits] = f
        }
        return out
    }()

    private static func font(_ span: HighlightSpan) -> UIFont {
        fonts[(span.isItalic ? 1 : 0) | (span.isBold ? 2 : 0)] ?? FileCodeMetrics.font
    }

    /// At most `units` UTF-16 units, cut on a Character boundary.
    static func clip(_ s: String, _ units: Int) -> String {
        if s.utf16.count <= units { return s }
        var n = 0
        var end = s.startIndex
        for i in s.indices {
            let w = s[i].utf16.count
            if n + w > units { break }
            n += w
            end = s.index(after: i)
        }
        return String(s[..<end])
    }
}

/// The list itself. `row(i)` draws row `i`; bump `version` when what it draws changes (colors
/// landed, the theme flipped), and the rows on screen redraw without a reload.
struct FileCodeList: UIViewRepresentable {
    let count: Int
    /// The widest row's width; narrower than the screen fills the screen.
    let contentWidth: CGFloat
    var initialIndex = 0
    var version = 0
    var background: UIColor = .clear
    let refreshing: Bool
    let onRefresh: () -> Void
    /// The first and last rows on screen, as they change.
    var onVisible: ((Int, Int) -> Void)?
    let row: (Int) -> FileCodeRow

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> FileCodeCollectionView {
        let layout = FileCodeLayout()
        let view = FileCodeCollectionView(frame: .zero, collectionViewLayout: layout)
        view.register(FileCodeCell.self, forCellWithReuseIdentifier: FileCodeCell.id)
        view.dataSource = context.coordinator
        view.delegate = context.coordinator
        // Prefetched cells aren't "visible", so a version bump would leave them stale.
        view.isPrefetchingEnabled = false
        view.isDirectionalLockEnabled = true
        view.bouncesHorizontally = false
        view.alwaysBounceVertical = true
        view.contentInsetAdjustmentBehavior = .always
        view.accessibilityIdentifier = "file-code"
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pulled), for: .valueChanged)
        view.refreshControl = refresh
        view.pendingIndex = initialIndex
        context.coordinator.view = view
        apply(view, context.coordinator, first: true)
        return view
    }

    func updateUIView(_ view: FileCodeCollectionView, context: Context) {
        apply(view, context.coordinator, first: false)
    }

    private func apply(_ view: FileCodeCollectionView, _ c: Coordinator, first: Bool) {
        c.row = row
        c.onRefresh = onRefresh
        c.onVisible = onVisible
        view.backgroundColor = background
        let layout = view.collectionViewLayout as! FileCodeLayout
        if first || layout.count != count || layout.contentWidth != contentWidth {
            layout.count = count
            layout.contentWidth = contentWidth
            c.count = count
            c.version = version
            layout.invalidateLayout()
            view.reloadData()
        } else if c.version != version {
            c.version = version
            for path in view.indexPathsForVisibleItems {
                (view.cellForItem(at: path) as? FileCodeCell)?.configure(row(path.item))
            }
        }
        if let rc = view.refreshControl, !refreshing, rc.isRefreshing { rc.endRefreshing() }
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate {
        weak var view: FileCodeCollectionView?
        var count = 0
        var version = 0
        var row: (Int) -> FileCodeRow = { _ in FileCodeRow(columns: []) }
        var onRefresh: () -> Void = {}
        var onVisible: ((Int, Int) -> Void)?
        private var lastVisible: (Int, Int)?

        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { count }

        func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: FileCodeCell.id, for: indexPath) as! FileCodeCell
            #if DEBUG
            let start = CACurrentMediaTime()
            cell.configure(row(indexPath.item))
            if let bench = view?.bench {
                bench.configTime += CACurrentMediaTime() - start
                bench.configured += 1
            }
            #else
            cell.configure(row(indexPath.item))
            #endif
            return cell
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) { reportVisible() }

        @objc func pulled() { onRefresh() }

        func reportVisible() {
            guard let view, count > 0, let onVisible else { return }
            let inset = view.adjustedContentInset
            let top = view.contentOffset.y + inset.top - FileCodeMetrics.pad
            let height = view.bounds.height - inset.top - inset.bottom
            guard height > 0 else { return }
            let first = max(0, min(count - 1, Int(floor(top / FileCodeMetrics.row))))
            let last = max(first, min(count - 1, Int(floor((top + height - 1) / FileCodeMetrics.row))))
            if let lastVisible, lastVisible == (first, last) { return }
            lastVisible = (first, last)
            onVisible(first, last)
        }
    }
}

/// Opens at `pendingIndex` once it has a size, and reports what's on screen after every layout.
final class FileCodeCollectionView: UICollectionView {
    var pendingIndex: Int?
    #if DEBUG
    var bench: FileCodeBench?
    #endif

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.height > 0 else { return }
        if let index = pendingIndex {
            pendingIndex = nil
            let inset = adjustedContentInset
            let maxY = max(-inset.top, collectionViewLayout.collectionViewContentSize.height + inset.bottom - bounds.height)
            let y = FileCodeMetrics.pad + CGFloat(index) * FileCodeMetrics.row - inset.top
            contentOffset = CGPoint(x: -inset.left, y: min(maxY, max(-inset.top, y)))
        }
        #if DEBUG
        if bench == nil, FileCodeBench.enabled, numberOfItems(inSection: 0) > 1000 {
            let b = FileCodeBench(view: self)
            bench = b
            // After the first highlight lands, so the run measures colored rows.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { b.start() }
        }
        #endif
        (delegate as? FileCodeList.Coordinator)?.reportVisible()
    }
}

/// Every row is `row` tall and as wide as the widest (or the screen), stacked under `pad`.
final class FileCodeLayout: UICollectionViewLayout {
    var count = 0
    var contentWidth: CGFloat = 0

    private var width: CGFloat {
        guard let cv = collectionView else { return contentWidth }
        let inset = cv.adjustedContentInset
        return max(contentWidth, cv.bounds.width - inset.left - inset.right)
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: width, height: FileCodeMetrics.pad * 2 + CGFloat(count) * FileCodeMetrics.row)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard count > 0 else { return [] }
        let first = max(0, Int(floor((rect.minY - FileCodeMetrics.pad) / FileCodeMetrics.row)))
        let last = min(count - 1, Int(floor((rect.maxY - FileCodeMetrics.pad) / FileCodeMetrics.row)))
        guard first <= last else { return [] }
        return (first...last).map { attributes($0) }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        indexPath.item < count ? attributes(indexPath.item) : nil
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != collectionView?.bounds.width
    }

    private func attributes(_ i: Int) -> UICollectionViewLayoutAttributes {
        let a = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: i, section: 0))
        a.frame = CGRect(x: 0, y: FileCodeMetrics.pad + CGFloat(i) * FileCodeMetrics.row, width: width, height: FileCodeMetrics.row)
        return a
    }
}

final class FileCodeCell: UICollectionViewCell {
    static let id = "FileCodeCell"
    private var labels: [UILabel] = []
    private var columns: [FileCodeColumn] = []
    private let edge = UIView()
    private var edgeWidth: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.addSubview(edge)
        edge.isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    func configure(_ row: FileCodeRow) {
        backgroundColor = row.background
        edgeWidth = row.edgeWidth
        edge.backgroundColor = row.edgeColor
        while labels.count < row.columns.count {
            let l = UILabel()
            l.numberOfLines = 1
            l.lineBreakMode = .byClipping
            contentView.addSubview(l)
            labels.append(l)
        }
        for (i, l) in labels.enumerated() {
            guard i < row.columns.count else {
                l.isHidden = true
                continue
            }
            let col = row.columns[i]
            l.isHidden = false
            l.attributedText = col.text
            l.textAlignment = col.alignment
            l.isAccessibilityElement = !col.accessibilityHidden && col.text.length > 0
            l.accessibilityValue = col.accessibilityValue
        }
        columns = row.columns
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let h = bounds.height
        edge.frame = CGRect(x: 0, y: 0, width: edgeWidth, height: h)
        var x = edgeWidth
        for (i, col) in columns.enumerated() where i < labels.count {
            let l = labels[i]
            x += col.leading
            if let w = col.width {
                l.frame = CGRect(x: x, y: 0, width: max(0, w - col.leading - col.trailing), height: h)
                x += w - col.leading
            } else {
                // Only as wide as its text: a label's backing store is its whole frame, and a
                // row can be thousands of points wide.
                let room = max(0, bounds.width - x - col.trailing)
                l.frame = CGRect(x: x, y: 0, width: min(room, ceil(l.intrinsicContentSize.width)), height: h)
                x = bounds.width
            }
        }
    }
}
