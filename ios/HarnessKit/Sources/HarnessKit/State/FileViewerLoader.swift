import Foundation
import Observation

/// A request's state on the file viewer.
public enum FileLoad<T: Sendable & Equatable>: Equatable, Sendable {
    case loading
    case ok(T)
    case error(FileLoadError)

    public var value: T? {
        if case let .ok(v) = self { return v }
        return nil
    }
}

/// The file viewer's requests (HarnessClient conforms).
public protocol FileViewerClient: Sendable {
    func ticketFile(_ key: String, path: String) async throws -> FileView
    func projectFile(_ id: String, path: String) async throws -> FileView
    func ticketFileDiff(_ key: String, path: String) async throws -> FileDiff
    func projectFileDiff(_ id: String, path: String) async throws -> FileDiff
}

extension HarnessClient: FileViewerClient {}

/// The file viewer's loading: the file, then, when git says it
/// changed, its diff. A refresh keeps the old diff on screen while the new one loads. Lines and
/// patch rows are worked out off the main actor once per load, so a 2 MB file never splits on
/// every render.
@MainActor
@Observable
public final class FileViewerLoader {
    public private(set) var file: FileLoad<FileView> = .loading
    /// Nil when the file has no diff (clean, outside git, or the file failed to load)
    public private(set) var diff: FileLoad<FileDiff>?
    /// The loaded file's lines; nil until it loads, and for a file without contents
    public private(set) var text: FileText?
    /// The loaded diff's rows
    public private(set) var rows: [PatchRow] = []
    public private(set) var refreshing = false

    public let root: FileRoot
    public let path: String
    private let client: any FileViewerClient
    /// Bumped per load, so a slower earlier load can't overwrite a later one.
    private var generation = 0

    public init(client: any FileViewerClient, root: FileRoot, path: String) {
        self.client = client
        self.root = root
        self.path = path
    }

    public func load() async {
        generation += 1
        let gen = generation
        let client = client
        let root = root
        let path = path
        let result: FileLoad<FileView>
        do {
            result = .ok(try await root.fetchFile(client, path))
        } catch {
            result = .error(FileLoadError(error))
        }
        guard gen == generation else { return }
        if let view = result.value {
            let contents = view.contents
            let next = await Task.detached(priority: .userInitiated) { contents.map(FileText.init) }.value
            guard gen == generation else { return }
            // The same contents keep the same lines, so the body keeps its colors and scroll.
            if next != text { text = next }
        } else {
            text = nil
        }
        file = result
        guard let view = result.value, FileViewerRules.hasDiff(view) else {
            diff = nil
            rows = []
            return
        }
        if diff == nil { diff = .loading }
        let shown = view.path
        let next: FileLoad<FileDiff>
        do {
            next = .ok(try await root.fetchDiff(client, shown))
        } catch {
            next = .error(FileLoadError(error))
        }
        guard gen == generation else { return }
        let patch = next.value?.patch ?? ""
        let nextRows = await Task.detached(priority: .userInitiated) { FileViewer.patchRows(patch) }.value
        guard gen == generation else { return }
        rows = nextRows
        diff = next
    }

    /// Pull to refresh (and Try again): `refreshing` while it reloads.
    public func refresh() async {
        refreshing = true
        await load()
        refreshing = false
    }
}

extension FileRoot {
    fileprivate func fetchFile(_ client: any FileViewerClient, _ path: String) async throws -> FileView {
        switch self {
        case let .ticket(key): try await client.ticketFile(key, path: path)
        case let .project(id): try await client.projectFile(id, path: path)
        }
    }

    fileprivate func fetchDiff(_ client: any FileViewerClient, _ path: String) async throws -> FileDiff {
        switch self {
        case let .ticket(key): try await client.ticketFileDiff(key, path: path)
        case let .project(id): try await client.projectFileDiff(id, path: path)
        }
    }
}
