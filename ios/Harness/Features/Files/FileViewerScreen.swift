import HarnessKit
import SwiftUI
import UIKit

/// The file a chat link points at (opened from a harness://file/… link in any markdown): the file
/// in the @pierre/diffs editor (a WKWebView, EditorWebHost) with line numbers, opened at and marking the
/// linked lines, plus a Diff tab (the editor package's side-by-side diff view) with its uncommitted changes when git
/// says it has some. The file is editable: Save writes it back, and Save on blur (Settings →
/// General) writes whenever the editor loses focus. The decisions are HarnessKit's FileViewerRules,
/// FileEditRules and FileEditorModel; FileEditorSession ties them to the editors.
struct FileViewerScreen: View {
    let params: FileRouteParams
    /// The docked sheet this file is the root of (a file card), nil when it's pushed onto a stack.
    /// Leaving a card closes it by id; leaving a pushed file pops it.
    var cardID: Int?
    /// Lines a later link marked in this open card (`TicketSheet.revealed`).
    var reveal: FileReveal?

    @Environment(\.palette) private var c

    var body: some View {
        let target = FileViewer.readFileParams(params)
        if let target, let root = target.root {
            FileViewerContent(root: root, path: target.path, range: target.range, cardID: cardID, reveal: reveal)
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

/// Identifies this screen to the panel's close button (TicketPanelCloser).
private final class PanelOwner {}

private struct FileViewerContent: View {
    let root: FileRoot
    let path: String
    let range: ClosedRange<Int>?
    let cardID: Int?
    let reveal: FileReveal?

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    /// False while another docked sheet is on top (or the sheet is minimized): this editor is
    /// mounted but out of sight, which is it losing focus.
    @Environment(\.sheetFront) private var front
    /// The iPad panel's close button and Escape, which close this file's card while it's on top there.
    @Environment(TicketPanelCloser.self) private var panelCloser: TicketPanelCloser?
    @State private var onScreen = PanelOwner()
    /// The dialog is for closing the whole card (the panel's ✕) rather than going back a screen.
    @State private var closingCard = false
    @State private var session: FileEditorSession?
    @State private var tab = FileViewerTab.file
    @State private var askingToLeave = false
    /// The lines a later link marked, once one has: they replace the opening link's.
    @State private var revealedRange: ClosedRange<Int>?
    private var saveOnBlur: Bool { SettingsRules.saveOnBlur(store.state.settings?.saveOnBlur) }

    var body: some View {
        let loader = session?.loader
        let view = loader?.file.value
        let shownPath = view?.path ?? path
        let hasDiff = view.map(FileViewerRules.hasDiff) ?? false
        let shown = hasDiff ? tab : .file
        let shownRange = revealedRange ?? range
        let dirty = session?.model.dirty ?? false
        // Dirty with Save on blur off, or after a save that failed: the back button asks, and
        // swiping back or down can't skip it.
        let guarded = dirty && (!saveOnBlur || session?.model.saveError != nil)
        VStack(spacing: 0) {
            FileInfoBar(
                path: shownPath, view: view, lineCount: loader?.text?.lines.count, range: shownRange,
                editing: shown == .file ? session?.model : nil, canEdit: view.map(FileEditRules.canEdit) ?? false
            ) { session?.saveNow() }
            if hasDiff, let loader {
                FileTabsBar(tab: $tab, rows: loader.rows)
            }
            Group {
                if let session, let loader {
                    switch loader.file {
                    case .loading:
                        LoadingScreen()
                    case let .error(e):
                        FileErrorView(copy: FileViewerRules.errorCopy(.file, e, path: path)) { Task { await session.retry() } }
                    case let .ok(v):
                        ZStack {
                            FileBody(view: v, host: session.fileHost)
                                .opacity(shown == .file ? 1 : 0)
                                .allowsHitTesting(shown == .file)
                            if hasDiff {
                                FileDiffBody(path: v.path, diff: loader.diff, rows: loader.rows, host: session.diffHost) { await session.retry() }
                                    .opacity(shown == .diff ? 1 : 0)
                                    .allowsHitTesting(shown == .diff)
                            }
                        }
                    }
                } else {
                    LoadingScreen()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(c.bg)
        .navigationTitle(FileViewerRules.fileName(shownPath))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(guarded)
        // Only the card on top: a dirty file parked behind another card mustn't stop that one's swipe down.
        .interactiveDismissDisabled(guarded && front)
        .toolbar {
            if guarded {
                ToolbarItem(placement: .topBarLeading) {
                    // A card has no screen to go back to: it closes, whatever presents it.
                    Button { closingCard = false; askingToLeave = true } label: {
                        if cardID != nil { Label("Close", systemImage: "xmark") } else { Label("Back", systemImage: "chevron.left") }
                    }
                }
            }
            ToolbarItem(placement: .principal) { title(shownPath) }
            ToolbarItem(placement: .topBarTrailing) { moreMenu(shownPath) }
        }
        .confirmationDialog("Save changes to \(FileViewerRules.fileName(shownPath))?", isPresented: $askingToLeave, titleVisibility: .visible) {
            Button("Save") {
                Task {
                    if await session?.save() == true { leave() }
                }
            }
            Button("Discard changes", role: .destructive) {
                session?.discard()
                leave()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Your edits aren't saved yet.")
        }
        .task {
            guard session == nil else { return }
            guard let client = store.client as? FileViewerClient else { return }
            let s = FileEditorSession(
                client: client, root: root, path: path, range: reveal?.range ?? revealedRange ?? range, theme: FileEditorTheme(c.theme.pluginInfo),
                background: UIColor(c.bg), saveOnBlur: { [store] in SettingsRules.saveOnBlur(store.state.settings?.saveOnBlur) })
            s.onLeaveFailed = { [router, cardID, weak s] in
                // The card is gone and its save failed: it comes back holding the edits (a pushed file
                // is still under its sheet; the edits wait for the file to open).
                guard let cardID, !router.dockedSheets.contains(where: { $0.id == cardID }) else { return }
                router.push(.file(FileRouteParams(
                    path: path, ticket: { if case let .ticket(k) = root { k } else { nil } }(),
                    project: { if case let .project(id) = root { id } else { nil } }(),
                    start: (s?.range ?? range).map { String($0.lowerBound) }, end: (s?.range ?? range).map { String($0.upperBound) })))
            }
            session = s
            await s.start()
        }
        .onChange(of: front, initial: true) { _, front in
            if front {
                // The panel's ✕ and Escape: a dirty file with Save on blur off asks first.
                panelCloser?.take(onScreen) {
                    // Read when it's pressed: this closure outlives the body that made it.
                    if (session?.model.dirty ?? false) && (!saveOnBlur || session?.model.saveError != nil) {
                        closingCard = true
                        askingToLeave = true
                    } else if session?.model.dirty ?? false {
                        // Save on blur: write first, and keep the card (with the failure showing) if that fails.
                        Task { if await session?.save() == true { closeCard() } }
                    } else { closeCard() }
                }
            } else {
                panelCloser?.release(onScreen)
                // Another card came to the front: the editor loses focus like it does on blur.
                session?.fileHost.resignFocus()
                session?.didBackground()
            }
        }
        .onChange(of: reveal, initial: true) { _, next in
            // A link to this file again: scroll the card to the new lines. A card that mounts with one
            // already set (or whose editor isn't ready) opens on them: the session remembers the range.
            guard let lines = next?.range else { return }
            revealedRange = lines
            tab = .file
            session?.reveal(lines)
        }
        .onChange(of: tab) { _, _ in
            // The editor under the other tab loses focus: its blur saves (Save on blur) and the keyboard goes down.
            session?.fileHost.resignFocus()
        }
        .onChange(of: c.theme.pluginInfo) { _, info in session?.setTheme(FileEditorTheme(info), background: UIColor(c.bg)) }
        .onChange(of: phase) { _, now in
            switch now {
            case .active: Task { await session?.didForeground() }
            case .background: session?.didBackground()
            default: break
            }
        }
        .onAppear { session?.didReturn() }
        .onDisappear {
            panelCloser?.release(onScreen)
            session?.didLeave()
        }
    }

    /// After Save or Discard: closes the card (by id, since the top card may have changed during a
    /// save; the panel's ✕ on a pushed file closes the sheet it's in) or pops back a screen.
    private func leave() {
        let closing = closingCard
        closingCard = false
        if cardID != nil || closing { closeCard() } else { dismiss() }
    }

    private func closeCard() {
        if let cardID { router.closeSheet(id: cardID) } else { router.dismissSheet() }
    }

    private var subtitle: String {
        if case let .project(id) = root { return FileViewerRules.subtitle(root, projectName: store.state.projects[id]?.name) }
        return FileViewerRules.subtitle(root, projectName: nil)
    }

    private func title(_ shownPath: String) -> some View {
        let isTicket = if case .ticket = root { true } else { false }
        return VStack(spacing: 0) {
            Text(FileViewerRules.fileName(shownPath))
                .font(.scaled(size: 16, weight: .semibold))
                .foregroundStyle(c.text)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(subtitle)
                .font(isTicket ? .mono(12) : .scaled(size: 12))
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
                haptic(.success)
            }
            Button("Copy link", systemImage: "link") {
                UIPasteboard.general.string = FileViewerRules.link(path: shownPath, root: root, range: revealedRange ?? range)
                haptic(.success)
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

/// The path (head-truncated, selectable), the git badge and "size · N lines · lines X–Y"; on the file
/// tab of an editable file, an unsaved dot and the Save button.
private struct FileInfoBar: View {
    let path: String
    let view: FileView?
    let lineCount: Int?
    let range: ClosedRange<Int>?
    let editing: FileEditorModel?
    let canEdit: Bool
    let save: () -> Void

    @Environment(\.palette) private var c
    @Environment(\.displayScale) private var scale

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
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
                            .font(.scaled(size: 12.5))
                            .foregroundStyle(c.text3)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
            if let editing, canEdit {
                editControls(editing)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { c.border.frame(height: 1 / scale) }
    }

    private func editControls(_ model: FileEditorModel) -> some View {
        HStack(spacing: 8) {
            if let status = FileEditRules.statusLabel(saving: model.saving, error: model.saveError) {
                Text(status)
                    .font(.scaled(size: 12.5))
                    .foregroundStyle(model.saving ? c.text3 : c.red)
                    .lineLimit(1)
            } else if model.dirty {
                Circle().fill(c.amber).frame(width: 8, height: 8)
                    .accessibilityLabel("Unsaved changes")
            }
            HButton("Save", small: true, action: save)
                .disabled(!model.dirty || model.saving)
        }
    }
}

/// File / Diff, drawn as a segmented control from two buttons (AXe lists a segmented Picker as one
/// unlabeled element, and the UI tests tap the segment whose label starts "Diff").
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
                .font(.scaled(size: 14, weight: on ? .semibold : .regular))
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


/// An editor's web view over the app background, with a spinner until its page is ready.
private struct EditorSurface: View {
    let host: EditorWebHost

    @Environment(\.palette) private var c

    var body: some View {
        ZStack {
            c.bg
            EditorWebViewRepresentable(host: host)
                .opacity(host.ready ? 1 : 0)
            if !host.ready { Spinner() }
        }
        // The web view insets itself for the keyboard and keeps the caret in view.
        .ignoresSafeArea(.keyboard)
        .ignoresSafeArea(.container, edges: .bottom)
    }
}

/// The file: the editor (or, for a file it can't show, why not).
private struct FileBody: View {
    let view: FileView
    let host: EditorWebHost

    @Environment(\.palette) private var c
    @Environment(\.displayScale) private var scale

    var body: some View {
        switch FileViewerRules.fileBody(view) {
        case let .tooLarge(message):
            EmptyState(icon: "fileText", title: "Too large to show", message: message)
        case let .binary(message):
            EmptyState(icon: "image", title: "Binary file", message: message)
        case let .lines(truncated):
            editor(truncated: truncated)
        case .empty:
            editor(truncated: false)
        }
    }

    private func editor(truncated: Bool) -> some View {
        VStack(spacing: 0) {
            if truncated {
                Text("The file changed while it was read; this is only its start, and it can't be saved.")
                    .font(.scaled(size: 12.5))
                    .foregroundStyle(c.text3)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .bottom) { c.border.frame(height: 1 / scale) }
            }
            EditorSurface(host: host)
        }
    }
}

/// The uncommitted changes: the side-by-side diff view, the last commit beside the file as it is.
private struct FileDiffBody: View {
    let path: String
    let diff: FileLoad<FileDiff>?
    let rows: [PatchRow]
    let host: EditorWebHost
    let onRetry: () async -> Void

    var body: some View {
        switch FileViewerRules.diffBody(diff, rows: rows) {
        case .loading:
            LoadingScreen()
        case let .error(e):
            FileErrorView(copy: FileViewerRules.errorCopy(.diff, e, path: path)) { Task { await onRetry() } }
        case .tooLarge:
            EmptyState(icon: "branch", title: "Too many changes to show", message: "The diff is over 4 MB.")
        case .noChanges:
            EmptyState(icon: "checkCircle", title: "No uncommitted changes", message: "The file matches the last commit.")
        case .binary:
            EmptyState(icon: "image", title: "Binary file changed", message: "Git can't show a line-by-line diff for it.")
        case .rows:
            EditorSurface(host: host)
        }
    }
}
