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
    @ObservationIgnored let range: ClosedRange<Int>?
    @ObservationIgnored private let saveOnBlur: () -> Bool
    /// The file editor has been opened with the loaded file once; a later open (the web view's
    /// process died) restores the unsaved contents instead.
    @ObservationIgnored private var openedOnce = false
    @ObservationIgnored private var discarded = false

    init(client: any FileViewerClient, root: FileRoot, path: String, range: ClosedRange<Int>?, theme: FileEditorTheme, background: UIColor, saveOnBlur: @escaping () -> Bool) {
        loader = FileViewerLoader(client: client, root: root, path: path)
        model = FileEditorModel(client: client, root: root, path: path)
        self.range = range
        self.theme = theme
        self.saveOnBlur = saveOnBlur
        for host in [fileHost, diffHost] { host.setBackground(background) }
        fileHost.onReady = { [weak self] in self?.openFile() }
        diffHost.onReady = { [weak self] in self?.openDiff() }
        fileHost.onEvent = { [weak self] in self?.fileEvent($0) }
        fileHost.webView.onSaveShortcut = { [weak self] in self?.saveNow() }
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
            model.opened(contents)
        }
        fileHost.send(.open(
            contents: model.latest ?? contents, language: language, theme: theme, range: range,
            readOnly: !editable, saved: model.saved))
        if range != nil { Task { await fileHost.readRevealedLine() } }
    }

    private func openDiff() {
        guard diffHost.ready, let diff = loader.diff?.value, !diff.patch.isEmpty, !diff.tooLarge else { return }
        diffHost.send(.diff(original: diff.oldContents ?? "", modified: diff.newContents ?? "", language: language, theme: theme))
    }

    // MARK: events

    private func fileEvent(_ event: FileEditorEvent) {
        switch event {
        case let .change(contents, dirty):
            discarded = false
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
        guard let view = loader.file.value, FileEditRules.canEdit(view) else { return }
        Task { await save(contents) }
    }

    @discardableResult
    func save(_ contents: String? = nil) async -> Bool {
        // Keep running if the app goes to the background mid-write, so the edit isn't lost to a suspend.
        let assertion = BackgroundAssertion("save-file")
        defer { assertion.end() }
        guard let written = await model.save(contents) else { return false }
        fileHost.send(.markSaved(written))
        haptic(.success)
        await loader.load(keepingFileOnError: true)
        openDiff()
        return true
    }

    // MARK: lifecycle

    /// The app went to the background, which is the editor losing focus.
    func didBackground() {
        if FileEditRules.saveOnBlur(dirty: model.dirty, saveOnBlur: saveOnBlur()) { saveNow() }
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
        guard !discarded else { return }
        guard FileEditRules.leave(dirty: model.dirty, saveOnBlur: saveOnBlur()) != .none else { return }
        // Through save(), so the editor's saved baseline follows (this fires too when a view is
        // pushed over the file, and the screen comes back).
        Task { await save() }
    }

    /// "Discard changes" on the back button: leaving then drops the edits instead of saving them.
    func discard() { discarded = true }
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
