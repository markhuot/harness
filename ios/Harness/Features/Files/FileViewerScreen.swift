import HarnessHighlight
import HarnessKit
import SwiftUI
import UIKit

/// The file a chat link points at (screens/FileViewer.tsx, opened from a harness://file/… link in
/// any markdown): the whole file syntax highlighted with line numbers, opened at and tinting the
/// linked lines, plus a Diff tab with its uncommitted changes when git says it has some. Lines are
/// a fixed-row-height list (FileCodeList), so a file of thousands of lines opens straight at its
/// range; a long file is colored a window at a time around what's on screen
/// (FileHighlightWindows). The decisions are HarnessKit's FileViewerRules and FileViewerLoader.
struct FileViewerScreen: View {
    let params: FileRouteParams

    @Environment(\.palette) private var c

    var body: some View {
        let target = FileViewer.readFileParams(params)
        if let target, let root = target.root {
            FileViewerContent(root: root, path: target.path, range: target.range)
        } else {
            EmptyState(
                icon: "fileText",
                title: "Can't open this file",
                message: target != nil ? "The link doesn't say which ticket or project the file is in." : "The link doesn't name a file."
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(c.bg)
            .navigationTitle(target.map { FileViewerRules.fileName($0.path) } ?? "File")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private enum FileViewerTab { case file, diff }

private struct FileViewerContent: View {
    let root: FileRoot
    let path: String
    let range: ClosedRange<Int>?

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c
    @State private var loader: FileViewerLoader?
    @State private var tab = FileViewerTab.file

    var body: some View {
        let view = loader?.file.value
        let shownPath = view?.path ?? path
        let hasDiff = view.map(FileViewerRules.hasDiff) ?? false
        let shown = hasDiff ? tab : .file
        VStack(spacing: 0) {
            FileInfoBar(path: shownPath, view: view, lineCount: loader?.text?.lines.count, range: range)
            if hasDiff, let loader {
                FileTabsBar(tab: $tab, rows: loader.rows)
            }
            Group {
                if let loader {
                    switch loader.file {
                    case .loading:
                        Spinner().frame(maxWidth: .infinity, maxHeight: .infinity)
                    case let .error(e):
                        FileErrorView(copy: FileViewerRules.errorCopy(.file, e, path: path)) { Task { await loader.refresh() } }
                    case let .ok(v):
                        if shown == .file {
                            FileBody(view: v, text: loader.text, range: range, refreshing: loader.refreshing) { await loader.refresh() }
                                .id("\(v.path):\(v.size)")
                        } else {
                            FileDiffBody(path: v.path, diff: loader.diff, rows: loader.rows, refreshing: loader.refreshing) { await loader.refresh() }
                        }
                    }
                } else {
                    Spinner().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(c.bg)
        .navigationTitle(FileViewerRules.fileName(shownPath))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { title(shownPath) }
            ToolbarItem(placement: .topBarTrailing) { moreMenu(shownPath) }
        }
        .task {
            guard loader == nil else { return }
            guard let client = store.client as? FileViewerClient else { return }
            let l = FileViewerLoader(client: client, root: root, path: path)
            loader = l
            await l.load()
        }
    }

    private var subtitle: String {
        if case let .project(id) = root { return FileViewerRules.subtitle(root, projectName: store.state.projects[id]?.name) }
        return FileViewerRules.subtitle(root, projectName: nil)
    }

    private func title(_ shownPath: String) -> some View {
        let isTicket = if case .ticket = root { true } else { false }
        return VStack(spacing: 0) {
            Text(FileViewerRules.fileName(shownPath))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(c.text)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(subtitle)
                .font(isTicket ? .mono(12) : .system(size: 12))
                .foregroundStyle(c.text3)
                .lineLimit(1)
        }
        .frame(maxWidth: 240)
        .accessibilityElement(children: .combine)
    }

    private func moreMenu(_ shownPath: String) -> some View {
        Menu {
            Button("Copy path", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = shownPath
                toasts.show("Path copied", kind: .info)
            }
            Button("Copy link", systemImage: "link") {
                UIPasteboard.general.string = FileViewerRules.link(path: shownPath, root: root, range: range)
                toasts.show("Link copied", kind: .info)
            }
            if case let .ticket(key) = root {
                Button("Open \(key)", systemImage: "arrow.right.circle") { router.push(.ticket(key: key, tab: nil)) }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More")
    }
}

/// The path (head-truncated, selectable), the git badge and "size · N lines · lines X–Y".
private struct FileInfoBar: View {
    let path: String
    let view: FileView?
    let lineCount: Int?
    let range: ClosedRange<Int>?

    @Environment(\.palette) private var c
    @Environment(\.displayScale) private var scale

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(path)
                .font(.mono(12))
                .foregroundStyle(c.text2)
                .lineLimit(1)
                .truncationMode(.head)
                .textSelection(.enabled)
            if let view {
                HStack(spacing: 6) {
                    switch FileViewerRules.gitBadge(view.git) {
                    case .untracked: Badge("Untracked", tone: .green)
                    case .modified: Badge("Modified", tone: .amber)
                    case nil: EmptyView()
                    }
                    if view.git.ignored { Badge("Ignored") }
                    Text(FileViewerRules.meta(size: view.size, lineCount: lineCount, range: range))
                        .font(.system(size: 12.5))
                        .foregroundStyle(c.text3)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { c.border.frame(height: 1 / scale) }
    }
}

/// File / Diff, drawn as a segmented control from two buttons (AXe lists a segmented Picker as one
/// unlabeled element, and sim-check taps the segment whose label starts "Diff").
private struct FileTabsBar: View {
    @Binding var tab: FileViewerTab
    let rows: [PatchRow]

    @Environment(\.palette) private var c
    @Environment(\.displayScale) private var scale

    var body: some View {
        let n = FileViewerRules.diffCounts(rows)
        HStack(spacing: 2) {
            segment(.file) { Text("File") }
            segment(.diff) {
                HStack(spacing: 6) {
                    Text("Diff")
                    if n.added > 0 || n.removed > 0 {
                        HStack(spacing: 4) {
                            if n.added > 0 { Text(verbatim: "+\(n.added)").foregroundStyle(c.diffAdd) }
                            if n.removed > 0 { Text(verbatim: "−\(n.removed)").foregroundStyle(c.diffDel) }
                        }
                        .font(.mono(12))
                    }
                }
            }
        }
        .padding(2)
        .background(c.bgSunken, in: .capsule)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .bottom) { c.border.frame(height: 1 / scale) }
    }

    private func segment(_ id: FileViewerTab, @ViewBuilder label: () -> some View) -> some View {
        let on = tab == id
        return Button {
            if !on {
                haptic(.select)
                tab = id
            }
        } label: {
            label()
                .font(.system(size: 14, weight: on ? .semibold : .regular))
                .foregroundStyle(on ? c.text : c.text2)
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 32)
                .background(on ? c.bgElev : .clear, in: .capsule)
                .shadow(color: on ? .black.opacity(0.08) : .clear, radius: 2, y: 1)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }
}

private struct FileErrorView: View {
    let copy: FileErrorCopy
    let retry: () -> Void

    var body: some View {
        EmptyState(icon: copy.icon, title: copy.title, message: copy.message) {
            if copy.retry {
                HButton("Try again", icon: "refresh", small: true, action: retry)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The app theme's Shiki theme, Pierre's when it names none (RN useSyntaxTheme).
private func syntaxTheme(_ c: Palette) -> String { SyntaxTheme.name(c.appearance, c.theme.syntaxTheme) }

/// Folded into a code list's version, so rows on screen redraw in a new app theme's colors.
private func paletteSeed(_ c: Palette) -> Int { c.theme.id.hashValue ^ (c.isDark ? 1 : 0) }

/// The whole file: a gutter of line numbers, the linked range tinted with an edge bar and bold
/// numbers, colored a window at a time.
private struct FileBody: View {
    let view: FileView
    let text: FileText?
    let range: ClosedRange<Int>?
    let refreshing: Bool
    let onRefresh: () async -> Void

    @Environment(\.palette) private var c
    @Environment(\.displayScale) private var scale
    @State private var windows: FileHighlightWindows<[HighlightSpan]>?
    /// The last highlight's default text color
    @State private var fg: String?
    @State private var version = 0
    @State private var drawer = FileCodeText()

    var body: some View {
        switch FileViewerRules.fileBody(view) {
        case let .tooLarge(message):
            EmptyState(icon: "fileText", title: "Too large to show", message: message)
        case let .binary(message):
            EmptyState(icon: "image", title: "Binary file", message: message)
        case .empty:
            EmptyState(icon: "fileText", title: "Empty file")
        case let .lines(truncated):
            VStack(spacing: 0) {
                if truncated {
                    Text("The file changed while it was read; this is only its start.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(c.text3)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) { c.border.frame(height: 1 / scale) }
                }
                if let text { list(text) }
            }
        }
    }

    private func list(_ text: FileText) -> some View {
        let theme = syntaxTheme(c)
        let lang = Diff.langForPath(view.path)
        let char = FileCodeMetrics.char
        let gutter = ceil(CGFloat(String(text.lines.count).count) * char) + 20
        let width = gutter + FileCodeMetrics.pad * 2 + CGFloat(min(FileViewerRules.maxColumns, text.longest)) * char
        let colors = (
            fg: fg.flatMap(drawer.color) ?? UIColor(c.text),
            text3: UIColor(c.text3),
            accent: UIColor(c.accent),
            accentSoft: UIColor(c.accentSoft),
            accentText: UIColor(c.accentText)
        )
        let colored = windows?.colored ?? [:]
        let drawer = drawer
        let range = range
        return FileCodeList(
            count: text.lines.count,
            contentWidth: width,
            initialIndex: FileViewer.initialScrollIndex(start: range?.lowerBound, total: text.lines.count),
            version: version &+ paletteSeed(c),
            background: UIColor(c.bg),
            refreshing: refreshing,
            onRefresh: { Task { await onRefresh() } },
            onVisible: { first, last in
                guard let w = windows?.window, first < w.lowerBound || last >= w.upperBound else { return }
                windows?.visible(first: first, last: last)
            },
            row: { i in
                let on = range?.contains(i + 1) ?? false
                let code = colored[i].map { drawer.spans($0, fg: colors.fg) } ?? drawer.plain(text.lines[i], color: colors.fg)
                return FileCodeRow(
                    columns: [
                        FileCodeColumn(
                            text: drawer.plain(String(i + 1), color: on ? colors.accentText : colors.text3, font: on ? FileCodeMetrics.semiboldFont : FileCodeMetrics.font),
                            width: gutter - 3, alignment: .right, trailing: 12, accessibilityHidden: true
                        ),
                        FileCodeColumn(text: code, trailing: FileCodeMetrics.pad, accessibilityValue: "Line \(i + 1)"),
                    ],
                    background: on ? colors.accentSoft : nil,
                    edgeWidth: 3,
                    edgeColor: on ? colors.accent : nil
                )
            }
        )
        .ignoresSafeArea(.container, edges: .bottom)
        .onAppear {
            if windows == nil { windows = FileHighlightWindows(lengths: text.lengths, center: (range?.lowerBound ?? 1) - 1) }
        }
        .onChange(of: text) {
            // New contents at the same path and size: start over around the range.
            windows = FileHighlightWindows(lengths: text.lengths, center: (range?.lowerBound ?? 1) - 1)
            version += 1
        }
        .onChange(of: theme) {
            windows?.reset()
            fg = nil
            version += 1
        }
        .task(id: FileHighlightJob(window: windows?.window, theme: theme, appearance: c.appearance)) {
            guard let w = windows?.window, !w.isEmpty, let lang else { return }
            let code = text.lines[w].joined(separator: "\n")
            let hl = Highlighter.app
            let result: Highlighted?
            if let hit = hl.cached(code, language: lang, theme: theme, diff: false) {
                result = hit
            } else {
                let job = try? await hl.highlight(code, language: lang, theme: theme, appearance: c.appearance)
                guard !Task.isCancelled else { return }
                result = job ?? nil
            }
            guard let result, windows?.lengths == text.lengths else { return }
            windows?.land(result.lines.map(\.spans), from: w.lowerBound)
            fg = result.fg
            version += 1
        }
    }
}

private struct FileHighlightJob: Equatable {
    let window: Range<Int>?
    let theme: String
    let appearance: ThemeAppearance
}

/// The uncommitted changes: old and new line numbers, a sign column and hunk headers, the code in
/// its syntax colors over the Git tab's add/del tints as full-width rows.
private struct FileDiffBody: View {
    let path: String
    let diff: FileLoad<FileDiff>?
    let rows: [PatchRow]
    let refreshing: Bool
    let onRefresh: () async -> Void

    @Environment(\.palette) private var c
    @State private var landed: Landed?
    @State private var version = 0
    @State private var drawer = FileCodeText()

    private struct Landed {
        let key: HighlightCache.Key
        let result: Highlighted?
    }

    var body: some View {
        switch FileViewerRules.diffBody(diff, rows: rows) {
        case .loading:
            Spinner().frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .error(e):
            FileErrorView(copy: FileViewerRules.errorCopy(.diff, e, path: path)) { Task { await onRefresh() } }
        case .tooLarge:
            EmptyState(icon: "branch", title: "Too many changes to show", message: "The diff is over 4 MB.")
        case .noChanges:
            EmptyState(icon: "checkCircle", title: "No uncommitted changes", message: "The file matches the last commit.")
        case .binary:
            EmptyState(icon: "image", title: "Binary file changed", message: "Git can't show a line-by-line diff for it.")
        case .rows:
            list(diff?.value?.patch ?? "")
        }
    }

    private func list(_ patch: String) -> some View {
        // The patch highlighted as a diff: its lines line up with parseDiff's, which PatchRow.source indexes.
        let key = HighlightCache.Key(code: patch, language: nil, theme: syntaxTheme(c), diff: true)
        let hl = landed?.key == key ? landed?.result : (Highlighter.app.cached(patch, language: nil, theme: key.theme, diff: true) ?? nil)
        let git = hl?.git ?? HighlightColors.gitColors(nil, c.appearance)
        let tints = try? HighlightColors.diffTints(c.tokens.bg, git, c.appearance)
        let char = FileCodeMetrics.char
        let most = rows.reduce(0) { max($0, $1.oldLine ?? 0, $1.newLine ?? 0) }
        let num = ceil(CGFloat(String(most).count) * char) + 10
        let longest = rows.reduce(0) { max($0, FileViewerRules.drawnLength($1.text)) }
        let width = num * 2 + char * 2 + FileCodeMetrics.pad * 2 + CGFloat(min(FileViewerRules.maxColumns, longest)) * char
        let drawer = drawer
        let colors = (
            fg: hl.flatMap { drawer.color($0.fg) } ?? UIColor(c.text),
            text3: UIColor(c.text3),
            sunken: UIColor(c.bgSunken),
            added: drawer.color(git.added) ?? UIColor(c.diffAdd),
            deleted: drawer.color(git.deleted) ?? UIColor(c.diffDel),
            addTint: tints.flatMap { drawer.color($0.add) },
            delTint: tints.flatMap { drawer.color($0.del) }
        )
        let rows = rows
        let lines = hl?.lines
        return FileCodeList(
            count: rows.count,
            contentWidth: width,
            version: version &+ paletteSeed(c),
            background: UIColor(c.bg),
            refreshing: refreshing,
            onRefresh: { Task { await onRefresh() } },
            row: { i in
                let r = rows[i]
                if r.kind == .hunk {
                    return FileCodeRow(
                        columns: [FileCodeColumn(text: drawer.plain(r.text, color: colors.text3), leading: FileCodeMetrics.pad)],
                        background: colors.sunken
                    )
                }
                let code: NSAttributedString = if let spans = lines.flatMap({ r.source < $0.count ? $0[r.source].spans.dropFirst() : nil }) {
                    drawer.spans(spans, fg: colors.fg)
                } else {
                    drawer.plain(r.text, color: colors.fg)
                }
                let sign = r.kind == .add ? "+" : r.kind == .del ? "−" : " "
                let signColor = r.kind == .add ? colors.added : r.kind == .del ? colors.deleted : colors.text3
                let number = { (n: Int?) in drawer.plain(n.map(String.init) ?? "", color: colors.text3) }
                return FileCodeRow(
                    columns: [
                        FileCodeColumn(text: number(r.oldLine), width: num, alignment: .right, accessibilityHidden: true),
                        FileCodeColumn(text: number(r.newLine), width: num, alignment: .right, accessibilityHidden: true),
                        FileCodeColumn(text: drawer.plain(sign, color: signColor), width: char * 2 + 8, alignment: .center, accessibilityHidden: true),
                        FileCodeColumn(
                            text: code, trailing: FileCodeMetrics.pad,
                            accessibilityValue: r.kind == .add ? "Added" : r.kind == .del ? "Removed" : nil
                        ),
                    ],
                    background: r.kind == .add ? colors.addTint : r.kind == .del ? colors.delTint : nil
                )
            }
        )
        .ignoresSafeArea(.container, edges: .bottom)
        .task(id: key) {
            let hl = Highlighter.app
            if let hit = hl.cached(key.code, language: nil, theme: key.theme, diff: true) {
                landed = Landed(key: key, result: hit)
                version += 1
                return
            }
            let job = try? await hl.highlightDiff(key.code, language: nil, theme: key.theme, appearance: c.appearance)
            guard !Task.isCancelled else { return }
            landed = Landed(key: key, result: job ?? nil)
            version += 1
        }
    }
}
