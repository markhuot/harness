import HarnessHighlight
import HarnessKit
import SwiftUI
import UIKit

/// A code block with syntax colors from the app theme's Shiki theme (through
/// HarnessHighlight): it renders plain monospace at once and swaps in the colored tokens when
/// they're ready, keeping unchanged lines' colors while a streaming block re-highlights. Diffs (a
/// `diff`/`patch` fence, or an untagged block that reads as one) get the Git tab's added/removed
/// line tints as full-width row backgrounds, with each file's code colored by its path. Wide code
/// scrolls sideways; long-press copies the whole block.
///
/// `language` is the fence's tag as written ("ts", "yml", "diff") or a Shiki id; nil or empty for
/// none. `highlightLines` is 1-based and inclusive (a file viewer's selected lines).
///
/// Show changes in the Spec tab passes `lineChanges`, one per line of `code`: added lines get a
/// green tint and bar, removed ones red and struck through, and Copy leaves the removed lines out.
/// `struck` strikes every line (a code block only in the older revision).
struct CodeBlockView: View {
    let code: String
    var language: String?
    var showLineNumbers = false
    var highlightLines: ClosedRange<Int>?
    var lineChanges: [MarkdownDiff.Change]?
    var struck = false

    @Environment(\.palette) private var c
    @Environment(\.displayScale) private var scale
    @State private var landed: Landed?
    /// The last colored lines, reused line by line while a changed block re-highlights.
    @State private var last: Landed?
    @State private var viewport: CGFloat = 0

    static let fontSize: CGFloat = HighlightedText.fontSize
    static let lineHeight: CGFloat = 18
    static let pad: CGFloat = 10

    private struct Landed: Equatable {
        let key: HighlightCache.Key
        let result: Highlighted?
    }

    var body: some View {
        let fence = language ?? ""
        let diff = lineChanges == nil && Code.codeKind(fence: fence, text: code) == .diff
        // The app theme's Shiki theme, Pierre's when it names none. Every
        // registry theme's syntaxTheme is bundled (HighlighterTests.everyAppThemesSyntaxThemeIsBundled).
        let theme = c.syntaxTheme
        let key = HighlightCache.Key(code: code, language: Code.codeLanguage(fence), theme: theme, diff: diff)
        let hl = highlighted(key)
        let lines = hl?.lines ?? PlainLines.reuse(PlainLines.lines(code, diff: diff), last?.key.theme == key.theme ? last?.result?.lines : nil)
        let style = HighlightedText.style(hl, tokens: c.tokens, appearance: c.appearance)
        Group {
            if diff || showLineNumbers || highlightLines != nil || lineChanges != nil {
                rowed(lines, style: style, git: hl?.git ?? HighlightColors.gitColors(nil, c.appearance))
            } else {
                ScrollView(.horizontal) {
                    // One Text, so Copy takes the whole block.
                    Text(HighlightedText.block(lines, style: style))
                        .strikethrough(struck, color: c.red.opacity(0.7))
                        .font(HighlightedText.font)
                        .lineSpacing(Self.lineHeight - Self.fontSize * 1.2)
                        .fixedSize()
                        .padding(Self.pad)
                }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            }
        }
        .background(c.bgSunken, in: .rect(cornerRadius: 8))
        .clipShape(.rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border, lineWidth: 1 / scale))
        .contentShape(.contextMenuPreview, .rect(cornerRadius: 8))
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = copyText }
        }
        .task(id: key) { await highlight(key) }
    }

    /// What Copy takes: the code, without the lines Show changes marks removed.
    private var copyText: String {
        guard let lineChanges else { return code }
        let lines = code.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.indices.filter { $0 >= lineChanges.count || lineChanges[$0] != .del }
            .map { String(String.UnicodeScalarView(lines[$0])) }
            .joined(separator: "\n")
    }

    private func change(_ i: Int) -> MarkdownDiff.Change {
        guard let lineChanges, i < lineChanges.count else { return .same }
        return lineChanges[i]
    }

    /// The colors for `key`: what this view's last job returned, else the shared cache.
    private func highlighted(_ key: HighlightCache.Key) -> Highlighted? {
        if let landed, landed.key == key { return landed.result }
        return Highlighter.app.cached(key.code, language: key.language, theme: key.theme, diff: key.diff) ?? nil
    }

    private func highlight(_ key: HighlightCache.Key) async {
        let hl = Highlighter.app
        let result: Highlighted?
        if let hit = hl.cached(key.code, language: key.language, theme: key.theme, diff: key.diff) {
            result = hit
        } else {
            let appearance = c.appearance
            let job = key.diff
                ? try? await hl.highlightDiff(key.code, language: key.language, theme: key.theme, appearance: appearance)
                : try? await hl.highlight(key.code, language: key.language, theme: key.theme, appearance: appearance)
            guard !Task.isCancelled else { return }
            result = job ?? nil
        }
        landed = Landed(key: key, result: result)
        if result != nil { last = landed }
    }

    /// One row per line: diff tints and the selected range as full-width row backgrounds, an
    /// optional line-number gutter that stays put while the code scrolls sideways.
    private func rowed(_ lines: [HighlightedLine], style: HighlightedText.Style, git: GitColors) -> some View {
        let tints = try? HighlightColors.diffTints(c.tokens.bgSunken, git, c.appearance)
        let rows = Array(lines.enumerated())
        let gutter = ceil(CGFloat(String(lines.count).count) * Self.fontSize * 0.62) + 12
        return HStack(alignment: .top, spacing: 0) {
            if showLineNumbers {
                VStack(alignment: .trailing, spacing: 0) {
                    ForEach(rows, id: \.offset) { i, line in
                        Text(String(i + 1))
                            .font(HighlightedText.font)
                            .foregroundStyle(c.text3)
                            .padding(.trailing, 8)
                            .frame(width: gutter, height: Self.lineHeight, alignment: .trailing)
                            .background(rowBackground(line, i, tints), in: .rect)
                    }
                }
                .padding(.vertical, Self.pad)
                .accessibilityHidden(true)
            }
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(rows, id: \.offset) { i, line in
                        // An empty line still takes up its line.
                        Text(line.spans.allSatisfy(\.text.isEmpty) ? AttributedString(" ") : HighlightedText.line(line, style: style))
                            .strikethrough(struck || change(i) == .del, color: c.red.opacity(0.7))
                            .font(HighlightedText.font)
                            .fixedSize()
                            .frame(height: Self.lineHeight)
                            .padding(.horizontal, Self.pad)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(rowBackground(line, i, tints), in: .rect)
                            .overlay(alignment: .leading) {
                                if change(i) != .same { Rectangle().fill(change(i) == .add ? c.green : c.red).frame(width: 3) }
                            }
                    }
                }
                .frame(minWidth: viewport, alignment: .leading)
                .padding(.vertical, Self.pad)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { viewport = $0 }
        }
    }

    private func rowBackground(_ line: HighlightedLine, _ i: Int, _ tints: DiffTints?) -> Color {
        if let highlightLines, highlightLines.contains(i + 1) { return c.accentSoft }
        switch change(i) {
        case .add: return c.greenSoft
        case .del: return c.redSoft
        case .same: break
        }
        switch line.kind {
        case .add: return tints.flatMap { Color(css: $0.add) } ?? .clear
        case .del: return tints.flatMap { Color(css: $0.del) } ?? .clear
        default: return .clear
        }
    }
}
