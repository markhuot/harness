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

    func start() async {
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
        guard fileHost.ready, let view = loader.file.value, let contents = view.contents else { return }
        let editable = FileEditRules.canEdit(view)
        if !openedOnce {
            openedOnce = true
            model.opened(contents)
        }
        fileHost.send(.open(
            contents: model.latest ?? contents, language: language, theme: theme, range: range,
            readOnly: !editable, saved: model.saved))
    }

    private func openDiff() {
        guard diffHost.ready, let diff = loader.diff?.value, !diff.patch.isEmpty, !diff.tooLarge else { return }
        diffHost.send(.diff(original: diff.oldContents ?? "", modified: diff.newContents ?? "", language: language, theme: theme))
    }

    // MARK: events

    private func fileEvent(_ event: FileEditorEvent) {
        switch event {
        case let .change(contents, dirty): model.edited(contents: contents, dirty: dirty)
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
        guard let written = await model.save(contents) else { return false }
        fileHost.send(.markSaved(written))
        haptic(.success)
        await loader.load()
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
        await loader.load()
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
        let model = model
        Task { await model.save() }
    }

    /// "Discard changes" on the back button: leaving then drops the edits instead of saving them.
    func discard() { discarded = true }

    func tearDown() {
        fileHost.tearDown()
        diffHost.tearDown()
    }
}
