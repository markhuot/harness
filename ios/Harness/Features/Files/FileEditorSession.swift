import HarnessKit
import Observation
import SwiftUI
import UIKit

/// The open file's editors and what ties them together: the file editor and the merge view (each its
/// own web view, so switching tabs never drops edits), the loader, the edit model, and the rules in
/// HarnessKit's FileEditRules deciding when a change is written. Last write wins.
@MainActor
@Observable
final class FileEditorSession {
    let loader: FileViewerLoader
    let model: FileEditorModel
    let fileHost = EditorWebHost()
    let diffHost = EditorWebHost()

    @ObservationIgnored var theme: FileEditorTheme
    /// The lines to open on: the link's, then whatever a later link to the open file marked.
    @ObservationIgnored private(set) var range: ClosedRange<Int>?
    @ObservationIgnored private let saveOnBlur: () -> Bool
    /// The file editor has been opened with the loaded file once; a later open (the web view's
    /// process died) restores the unsaved contents instead.
    @ObservationIgnored private var openedOnce = false
    /// This screen is on screen, counted in UnsavedEdits so a failed save on leave knows whether to keep.
    @ObservationIgnored private var attached = false
    /// Edits an earlier screen of this file couldn't save, which this one opens on.
    @ObservationIgnored private var kept: UnsavedEdits.Entry?
    /// A save on leave failed and the screen is gone: the owner shows the file again, with the edits.
    @ObservationIgnored var onLeaveFailed: (() -> Void)?

    init(client: any FileViewerClient, root: FileRoot, path: String, range: ClosedRange<Int>?, theme: FileEditorTheme, background: UIColor, saveOnBlur: @escaping () -> Bool) {
        loader = FileViewerLoader(client: client, root: root, path: path)
        model = FileEditorModel(client: client, root: root, path: path)
        self.range = range
        self.theme = theme
        self.saveOnBlur = saveOnBlur
        kept = UnsavedEdits.shared.take(root, path: path)
        attach()
        for host in [fileHost, diffHost] { host.setBackground(background) }
        fileHost.onReady = { [weak self] in self?.openFile() }
        diffHost.onReady = { [weak self] in self?.openDiff() }
        fileHost.onEvent = { [weak self] in self?.fileEvent($0) }
        fileHost.webView.onSaveShortcut = { [weak self] in self?.saveNow() }
    }

    private func attach() {
        guard !attached else { return }
        attached = true
        UnsavedEdits.shared.attach(model.root, path: model.path)
    }

    private func detach() {
        guard attached else { return }
        attached = false
        UnsavedEdits.shared.detach(model.root, path: model.path)
    }

    func start() async { await load() }

    /// "Try again" after a failed load: the web view is already ready, so nothing else would open
    /// the file once it arrives.
    func retry() async { await load() }

    private func load() async {
        await loader.load()
        openFile()
        openDiff()
    }

    func setTheme(_ next: FileEditorTheme, background: UIColor) {
        guard next != theme else { return }
        theme = next
        for host in [fileHost, diffHost] {
            host.setBackground(background)
            host.send(.theme(next))
        }
    }

    // MARK: opening

    private var language: String { loader.file.value?.path ?? loader.path }

    /// Opens the file editor on the loaded file, or on the unsaved text a reopened editor still owes.
    private func openFile() {
        guard fileHost.ready else { return }
        guard let view = loader.file.value, let contents = view.contents else {
            // The web view's process died while the last load is an error: reopen on the edits the
            // model still holds.
            if openedOnce, let latest = model.latest {
                fileHost.send(.open(contents: latest, language: language, theme: theme, range: range, readOnly: false, saved: model.saved))
            }
            return
        }
        let editable = FileEditRules.canEdit(view)
        if !openedOnce {
            openedOnce = true
            if let kept { model.restored(kept) } else { model.opened(contents) }
        }
        fileHost.send(.open(
            contents: model.latest ?? contents, language: language, theme: theme, range: range,
            readOnly: !editable, saved: model.saved))
    }

    /// A link to this open file marked other lines: the editor scrolls to and marks them.
    /// The lines are remembered too: an editor that isn't ready yet, or a restarted web view, opens on them.
    func reveal(_ lines: ClosedRange<Int>) {
        range = lines
        fileHost.send(.reveal(lines))
    }

    private func openDiff() {
        guard diffHost.ready, let diff = loader.diff?.value, !diff.patch.isEmpty, !diff.tooLarge else { return }
        diffHost.send(.diff(original: diff.oldContents ?? "", modified: diff.newContents ?? "", language: language, theme: theme))
    }

    // MARK: events

    private func fileEvent(_ event: FileEditorEvent) {
        // Discarded: nothing the editor still reports is new typing, or worth saving.
        guard !model.discarded else { return }
        switch event {
        case let .change(contents, dirty):
            model.edited(contents: contents, dirty: dirty)
        case let .dirty(dirty): model.dirtyChanged(dirty)
        case let .save(contents): saveNow(contents)
        case .blur: if FileEditRules.saveOnBlur(dirty: model.dirty, saveOnBlur: saveOnBlur()) { saveNow() }
        case .ready, .error, .contents: break
        }
    }

    // MARK: saving

    /// Writes the newest contents (or `contents`, what Cmd+S in the page handed out), tells the editor
    /// what's on disk now and refreshes the file's git state and diff.
    func saveNow(_ contents: String? = nil) {
        guard !model.discarded, let view = loader.file.value, FileEditRules.canEdit(view) else { return }
        Task { await save(contents) }
    }

    @discardableResult
    func save(_ contents: String? = nil) async -> Bool {
        // Keep running if the app goes to the background mid-write, so the edit isn't lost to a suspend.
        let assertion = BackgroundAssertion("save-file")
        defer { assertion.end() }
        guard let written = await model.save(contents) else { return false }
        UnsavedEdits.shared.drop(model.root, path: model.path)
        fileHost.send(.markSaved(written))
        haptic(.success)
        await loader.load(keepingFileOnError: true)
        openDiff()
        return true
    }

    // MARK: lifecycle

    /// The app went to the background, which is the editor losing focus.
    func didBackground() {
        if !model.discarded, FileEditRules.saveOnBlur(dirty: model.dirty, saveOnBlur: saveOnBlur()) { saveNow() }
    }

    /// The app came back: a clean editor reloads what's on disk (silently); a dirty one keeps its edits.
    func didForeground() async {
        guard FileEditRules.reloadOnForeground(dirty: model.dirty) else { return }
        // A save or an edit while the load was out makes what it read stale.
        let revision = model.revision
        await loader.load(keepingFileOnError: true)
        guard model.revision == revision else { return }
        if let contents = loader.file.value?.contents, !model.dirty, contents != model.latest {
            model.opened(contents)
            fileHost.send(.setContents(contents))
        }
        openDiff()
    }

    /// The screen is going away (popped, or swapped out). Dirty edits are saved, never dropped: the
    /// back button asks first when Save on blur is off, so a pop that gets here without asking
    /// (a sheet swiped away, a link opened over the file) saves too.
    func didLeave() {
        detach()
        guard !model.discarded else { return }
        guard FileEditRules.leave(dirty: model.dirty, saveOnBlur: saveOnBlur()) != .none else { return }
        // Through save(), so the editor's saved baseline follows (this fires too when a view is
        // pushed over the file, and the screen comes back).
        Task {
            guard await save() == false, let latest = model.latest, model.dirty else { return }
            // The write failed and nothing here can ask again: the edits wait for the file to open.
            // Unless the file is on screen again (this screen came back, or it was opened anew): that screen
            // holds its own edits, and an entry here would later restore this older text over newer.
            guard UnsavedEdits.shared.keep(model.root, path: model.path, contents: latest, saved: model.saved, error: model.saveError) else { return }
            onLeaveFailed?()
        }
    }

    /// The screen is back on screen (a view pushed over it was popped), so it still holds the edits.
    func didReturn() {
        attach()
        _ = UnsavedEdits.shared.take(model.root, path: model.path)
    }

    /// "Discard changes" on the back button: leaving then drops the edits instead of saving them.
    func discard() {
        model.discard()
    }
}

/// A UIKit background-task assertion held for the length of one save.
@MainActor
private final class BackgroundAssertion {
    private var id = UIBackgroundTaskIdentifier.invalid

    init(_ name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
