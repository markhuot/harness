import Foundation
import Observation

/// The open file's editing state: the newest contents the editor reported, whether they're unsaved,
/// and saving them. Last write wins: a save sends the whole file and doesn't look at what's on disk.
@MainActor
@Observable
public final class FileEditorModel {
    public private(set) var dirty = false
    public private(set) var saving = false
    /// The last save's failure, until the next one succeeds or the editor reopens
    public private(set) var saveError: String?
    /// The newest contents the editor reported (nil until it opens)
    public private(set) var latest: String?
    /// What's on disk as far as this screen knows: what it loaded, or last wrote. A reopened editor
    /// (the web view's process died) compares against it to stay dirty.
    public private(set) var saved: String?

    /// Bumped whenever `latest` or `saved` changes, so a slow reload can tell the editor moved on
    /// (typed, or saved) while it was out and drop its stale result.
    public private(set) var revision = 0

    public let root: FileRoot
    public let path: String
    @ObservationIgnored private let client: any FileViewerClient
    /// The save in flight, so the next waits for it and writes land in the order they were asked.
    @ObservationIgnored private var inflight: Task<String?, Never>?

    public init(client: any FileViewerClient, root: FileRoot, path: String) {
        self.client = client
        self.root = root
        self.path = path
    }

    /// The editor opened (or reloaded clean) with `contents`.
    public func opened(_ contents: String) {
        latest = contents
        saved = contents
        dirty = false
        saveError = nil
        revision += 1
    }

    /// The editor opened on edits an earlier screen of this file couldn't save (`UnsavedEdits`): dirty
    /// against what was on disk, with the failure still showing.
    public func restored(_ kept: UnsavedEdits.Entry) {
        latest = kept.contents
        saved = kept.saved ?? kept.contents
        dirty = kept.contents != saved
        saveError = kept.error
        revision += 1
    }

    /// The user chose "Discard changes": leaving drops the edits, and the editor's late events (an IME or
    /// autocorrect commit as the dialog takes focus) neither count as new typing nor trigger a save.
    public private(set) var discarded = false

    public func discard() { discarded = true }

    public func edited(contents: String, dirty: Bool) {
        guard !discarded else { return }
        latest = contents
        revision += 1
        self.dirty = dirty
    }

    public func dirtyChanged(_ dirty: Bool) {
        guard !discarded else { return }
        self.dirty = dirty
    }

    /// Writes `contents` (default: the newest the editor reported). Returns what was written when it
    /// succeeded, for the editor's `markSaved`; nil when it failed (`saveError` says why) or there
    /// was nothing to write. A save while another is in flight waits for it.
    @discardableResult
    public func save(_ contents: String? = nil) async -> String? {
        guard let text = contents ?? latest else { return nil }
        let previous = inflight
        let root = root
        let path = path
        let client = client
        let task = Task { () -> String? in
            _ = await previous?.value
            do {
                switch root {
                case let .ticket(key): _ = try await client.writeTicketFile(key, path: path, contents: text)
                case let .project(id): _ = try await client.writeProjectFile(id, path: path, contents: text)
                }
                return text
            } catch {
                self.saveError = localizedErrorMessage(error)
                return nil
            }
        }
        inflight = task
        saving = true
        let written = await task.value
        // Only the newest save settles the state.
        if inflight == task {
            inflight = nil
            saving = false
        }
        guard let written else { return nil }
        saveError = nil
        saved = written
        revision += 1
        // Still dirty when the document moved on while the write was out.
        if let latest { dirty = latest != written }
        return written
    }
}
