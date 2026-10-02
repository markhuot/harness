import HarnessHighlight
import HarnessKit
import SwiftUI

/// The built-in Changes tab (the git plugin's Changes page, drawn natively): what the ticket's
/// branch changed against its base (or a plain workdir's uncommitted changes, or the diff pinned
/// before the worktree went away), a file list that jumps to each diff, and the diffs, unified or
/// split, with syntax colors, expandable context and "Viewed" marks. It loads with the ticket and
/// refreshes on ticket events, reconnects and pull to refresh, and polls while the agent works.
/// State and rules live in HarnessKit's ChangesStore; this only draws.
struct ChangesTabView: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var board
    @Environment(\.scenePhase) private var phase
    @State private var model: ChangesStore?

    var body: some View {
        Group {
            if let model {
                ChangesTabContent(model: model)
            } else if board.api != nil {
                ChangesLoading()
            } else {
                EmptyState(icon: "alert", title: "Couldn't load changes", message: "Not connected to a Mac.")
            }
        }
        .task(id: ticket.key) {
            guard model?.ticketKey != ticket.key, let client = board.api else { return }
            model?.stop()
            let m = ChangesStore(ticketKey: ticket.key, source: PluginChangesSource(client: client), defaults: UserDefaults.standard, timers: TaskTimers())
            m.setBusy(ticket.busy)
            model = m
            m.refresh()
        }
        .onChange(of: ticket) { model?.ticketChanged(busy: ticket.busy) }
        .onChange(of: board.epoch) { model?.refresh() }
        .onChange(of: phase) { model?.setActive(phase == .active) }
        .onAppear { model?.setActive(true) }
        .onDisappear {
            model?.setActive(false)
            model?.stop()
        }
    }
}

private struct ChangesLoading: View {
    @Environment(\.palette) private var c

    var body: some View {
        VStack(spacing: 10) {
            Spinner()
            Text("Loading changes…").font(.scaled(size: 14)).foregroundStyle(c.text2)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

/// One thing the scroll view stacks: the overview, a file list row, a file's header, a gap, a line.
private enum ChangesItem: Identifiable {
    case overview
    case listTitle
    case listRow(ChangedFile)
    case header(ChangedFile)
    case placeholder(path: String, text: String)
    case gap(path: String, ChangesGap)
    case line(path: String, index: Int, ChangesLine)
    case split(path: String, index: Int, ChangesSplitRow)
    case fileEnd(path: String)

    var id: String {
        switch self {
        case .overview: "overview"
        case .listTitle: "list"
        case let .listRow(f): "list:\(f.path)"
        case let .header(f): "file:\(f.path)"
        case let .placeholder(path, _): "placeholder:\(path)"
        case let .gap(path, g): "gap:\(path):\(g.index)"
        case let .line(path, i, _): "line:\(path):\(i)"
        case let .split(path, i, _): "split:\(path):\(i)"
        case let .fileEnd(path): "end:\(path)"
        }
    }
}

/// Rows per file, kept while the file's diff, contents and expansion stay the same, so a redraw
/// (a highlight landing, a viewed toggle) doesn't rebuild every file's rows.
@MainActor
private final class ChangesRowsMemo {
    struct Entry {
        let key: String
        let rows: [ChangesRow]
        let split: [ChangesRows.Either]
        let source: String
        let codeCount: Int
        /// Each unified row's place among the code rows (its highlighted line); -1 for gaps
        let codes: [Int]
    }

    private var entries: [String: Entry] = [:]

    func entry(_ path: String, model: ChangesStore) -> Entry {
        let expanded = (model.expanded[path] ?? []).sorted().map(String.init).joined(separator: ",")
        let key = "\(model.fingerprints[path] ?? "-")|\(model.contents[path]?.count ?? -1)|\(expanded)"
        if let e = entries[path], e.key == key { return e }
        let rows = model.rows(path)
        var codes: [Int] = []
        var n = 0
        for r in rows {
            if case .line = r {
                codes.append(n)
                n += 1
            } else {
                codes.append(-1)
            }
        }
        let e = Entry(key: key, rows: rows, split: ChangesRows.split(rows), source: ChangesRows.highlightSource(rows, path: path), codeCount: n, codes: codes)
        entries[path] = e
        return e
    }
}

private struct ChangesTabContent: View {
    let model: ChangesStore

    @Environment(\.palette) private var c
    @State private var highlights = ChangesHighlights()
    @State private var memo = ChangesRowsMemo()
    @State private var width: CGFloat = 390

    var body: some View {
        Group {
            if let changes = model.changes {
                if changes.files.isEmpty {
                    let empty = ChangesRows.emptyState(changes)
                    ScrollView {
                        VStack(spacing: 0) {
                            ChangesOverview(model: model, width: width)
                            EmptyState(icon: "checkCircle", title: empty.title, message: empty.detail)
                                .padding(.top, 30)
                        }
                    }
                    .refreshable { await model.refresh()?.value }
                    .ticketHeroScroll()
                } else {
                    diffs(changes)
                }
            } else if let error = model.error {
                ScrollView {
                    EmptyState(icon: "alert", title: "Couldn't load changes", message: error) {
                        Button("Try again") { model.refresh() }.buttonStyle(.harness(.secondary, small: true, fullWidth: false))
                    }
                    .padding(.top, 30)
                }
                .refreshable { await model.refresh()?.value }
            } else {
                ChangesLoading()
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func diffs(_ changes: Changes) -> some View {
        let style = model.style(width: Double(width))
        let theme = c.syntaxTheme
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(items(changes, style: style)) { item in
                        row(item, style: style, theme: theme, proxy: proxy)
                    }
                }
                .padding(.bottom, 24)
            }
            .refreshable { await model.refresh()?.value }
            .ticketHeroScroll()
        }
    }

    private func items(_ changes: Changes, style: ChangesDiffStyle) -> [ChangesItem] {
        var out: [ChangesItem] = [.overview, .listTitle]
        out += changes.files.map(ChangesItem.listRow)
        for f in changes.files {
            out.append(.header(f))
            if model.isCollapsed(f.path) { continue }
            if let text = ChangesRows.placeholder(f, diff: model.diffs[f.path]) {
                out.append(.placeholder(path: f.path, text: text))
            } else {
                let e = memo.entry(f.path, model: model)
                if style == .split {
                    for (i, r) in e.split.enumerated() {
                        switch r {
                        case let .gap(g): out.append(.gap(path: f.path, g))
                        case let .row(s): out.append(.split(path: f.path, index: i, s))
                        }
                    }
                } else {
                    for (i, r) in e.rows.enumerated() {
                        switch r {
                        case let .gap(g): out.append(.gap(path: f.path, g))
                        case let .line(l): out.append(.line(path: f.path, index: i, l))
                        }
                    }
                }
            }
            out.append(.fileEnd(path: f.path))
        }
        return out
    }

    @ViewBuilder
    private func row(_ item: ChangesItem, style: ChangesDiffStyle, theme: String, proxy: ScrollViewProxy) -> some View {
        switch item {
        case .overview:
            ChangesOverview(model: model, width: width)
        case .listTitle:
            SectionTitle("Files")
                .padding(.horizontal, 14)
                .padding(.top, 6)
                .padding(.bottom, 6)
        case let .listRow(f):
            ChangesFileListRow(file: f, viewed: model.isViewed(f.path)) {
                withAnimation(.snappy) { proxy.scrollTo("file:\(f.path)", anchor: .top) }
            }
        case let .header(f):
            ChangesFileHeader(file: f, model: model)
                .padding(.top, 14)
        case let .placeholder(_, text):
            Text(text)
                .font(.scaled(size: 13))
                .foregroundStyle(c.text3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(c.bgElev)
                .changesCardSides(c)
        case let .gap(path, g):
            ChangesGapRow(gap: g, loading: model.loadingContents.contains(path)) { model.expand(path, gap: g.index) }
                .changesCardSides(c)
        case let .line(path, i, l):
            let e = memo.entry(path, model: model)
            let hl = highlights.code(path, source: e.source, theme: theme)
            ChangesLineRow(line: l, highlighted: hl.flatMap { h in e.codes[i] >= 0 && e.codes[i] < h.lines.count ? h.lines[e.codes[i]] : nil }, result: hl, gutter: gutter(path))
                .changesCardSides(c)
                .onChange(of: "\(theme)|\(e.key)", initial: true) { highlights.request(path, source: e.source, codeCount: e.codeCount, theme: theme, appearance: c.appearance) }
        case let .split(path, _, s):
            let e = memo.entry(path, model: model)
            let hl = highlights.code(path, source: e.source, theme: theme)
            ChangesSplitLineRow(row: s, highlighted: hl, gutter: gutter(path))
                .changesCardSides(c)
                .onChange(of: "\(theme)|\(e.key)", initial: true) { highlights.request(path, source: e.source, codeCount: e.codeCount, theme: theme, appearance: c.appearance) }
        case .fileEnd:
            UnevenRoundedRectangle(bottomLeadingRadius: 10, bottomTrailingRadius: 10)
                .fill(c.bgElev)
                .frame(height: 6)
                .overlay(UnevenRoundedRectangle(bottomLeadingRadius: 10, bottomTrailingRadius: 10).strokeBorder(c.border, lineWidth: 1 / 3))
                .padding(.horizontal, 10)
                .accessibilityHidden(true)
        }
    }

    /// Room for the file's largest line number.
    private func gutter(_ path: String) -> CGFloat {
        let biggest = model.diffs[path]?.hunks.last.map { max($0.additionStart + $0.additionCount, $0.deletionStart + $0.deletionCount) } ?? 1
        let contents = model.contents[path]?.count ?? 0
        return CGFloat(String(max(biggest, contents)).count) * 7.2 + 4
    }
}

extension View {
    /// The left and right edges of a file's card (its rows sit edge to edge between header and end).
    fileprivate func changesCardSides(_ c: Palette) -> some View {
        self
            .clipped()
            .overlay(alignment: .leading) { Rectangle().fill(c.border).frame(width: 1 / 3) }
            .overlay(alignment: .trailing) { Rectangle().fill(c.border).frame(width: 1 / 3) }
            .padding(.horizontal, 10)
    }
}
