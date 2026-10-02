import Foundation
import Synchronization
import Testing
@testable import HarnessKit

@MainActor
@Suite struct FileViewerLoaderTests {
    /// Answers each request from a queue per endpoint (a Deferred per call), recording the calls.
    final class FakeClient: FileViewerClient {
        let files = Mutex<[Deferred<FileView>]>([])
        let diffs = Mutex<[Deferred<FileDiff>]>([])
        let calls = Mutex<[String]>([])

        func ticketFile(_ key: String, path: String) async throws -> FileView { try await nextFile("ticketFile \(key) \(path)") }
        func projectFile(_ id: String, path: String) async throws -> FileView { try await nextFile("projectFile \(id) \(path)") }
        func ticketFileDiff(_ key: String, path: String) async throws -> FileDiff { try await nextDiff("ticketFileDiff \(key) \(path)") }
        func projectFileDiff(_ id: String, path: String) async throws -> FileDiff { try await nextDiff("projectFileDiff \(id) \(path)") }

        private func nextFile(_ call: String) async throws -> FileView {
            calls.withLock { $0.append(call) }
            return try await files.withLock { $0.removeFirst() }.value()
        }

        private func nextDiff(_ call: String) async throws -> FileDiff {
            calls.withLock { $0.append(call) }
            return try await diffs.withLock { $0.removeFirst() }.value()
        }

        @discardableResult
        func file(_ v: FileView) -> Deferred<FileView> {
            let d = Deferred<FileView>()
            d.resolve(v)
            files.withLock { $0.append(d) }
            return d
        }

        func fileFails(_ e: any Error) {
            let d = Deferred<FileView>()
            d.reject(e)
            files.withLock { $0.append(d) }
        }

        func pendingFile() -> Deferred<FileView> {
            let d = Deferred<FileView>()
            files.withLock { $0.append(d) }
            return d
        }

        func diff(_ v: FileDiff) {
            let d = Deferred<FileDiff>()
            d.resolve(v)
            diffs.withLock { $0.append(d) }
        }

        func diffFails(_ e: any Error) {
            let d = Deferred<FileDiff>()
            d.reject(e)
            diffs.withLock { $0.append(d) }
        }
    }

    static func view(_ path: String = "src/a.ts", contents: String? = "a\nb\n", repo: Bool = true, dirty: Bool = false) -> FileView {
        FileView(path: path, root: "/w", size: contents?.utf8.count ?? 0, contents: contents, git: FileGitState(repo: repo, tracked: true, dirty: dirty, untracked: false, ignored: false))
    }

    static let patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n"

    @Test func aCleanFileNeverAsksForADiff() async {
        let client = FakeClient()
        client.file(Self.view(dirty: false))
        let loader = FileViewerLoader(client: client, root: .ticket(key: "GREET-1"), path: "src/a.ts")
        await loader.load()
        #expect(loader.file.value?.path == "src/a.ts")
        #expect(loader.text?.lines == ["a", "b"])
        #expect(loader.diff == nil)
        #expect(client.calls.withLock { $0 } == ["ticketFile GREET-1 src/a.ts"])
    }

    @Test func aDirtyFileOutsideGitHasNoDiff() async {
        let client = FakeClient()
        client.file(Self.view(repo: false, dirty: true))
        let loader = FileViewerLoader(client: client, root: .project(id: "p1"), path: "a.ts")
        await loader.load()
        #expect(loader.diff == nil)
        #expect(client.calls.withLock { $0 } == ["projectFile p1 a.ts"])
    }

    @Test func aDirtyFileLoadsItsDiffByTheResolvedPath() async {
        let client = FakeClient()
        // The service normalizes the path ("./src/a.ts" → "src/a.ts"); the diff asks for its form.
        client.file(Self.view("src/a.ts", dirty: true))
        client.diff(FileDiff(path: "src/a.ts", patch: Self.patch))
        let loader = FileViewerLoader(client: client, root: .project(id: "p1"), path: "./src/a.ts")
        await loader.load()
        #expect(client.calls.withLock { $0 } == ["projectFile p1 ./src/a.ts", "projectFileDiff p1 src/a.ts"])
        #expect(loader.rows.map(\.kind) == [.hunk, .ctx, .del, .add])
        #expect(loader.diff?.value?.patch == Self.patch)
    }

    @Test func aFailedDiffKeepsItsStatus() async {
        let client = FakeClient()
        client.file(Self.view(dirty: true))
        client.diffFails(HarnessAPIError(status: 500, message: "boom"))
        let loader = FileViewerLoader(client: client, root: .ticket(key: "K-1"), path: "src/a.ts")
        await loader.load()
        #expect(loader.diff == .error(FileLoadError(status: 500, message: "boom")))
        #expect(loader.rows.isEmpty)
    }

    @Test func aFailedFileDropsTheDiffAndLines() async {
        let client = FakeClient()
        client.file(Self.view(dirty: true))
        client.diff(FileDiff(path: "src/a.ts", patch: Self.patch))
        let loader = FileViewerLoader(client: client, root: .ticket(key: "K-1"), path: "src/a.ts")
        await loader.load()
        #expect(loader.diff != nil)
        client.fileFails(HarnessAPIError(status: 404, message: "Not found"))
        await loader.refresh()
        #expect(loader.file == .error(FileLoadError(status: 404, message: "Not found")))
        #expect(loader.diff == nil)
        #expect(loader.text == nil)
        #expect(!loader.refreshing)
    }

    @Test func aNetworkErrorHasNoStatus() async {
        let client = FakeClient()
        client.fileFails(URLError(.notConnectedToInternet))
        let loader = FileViewerLoader(client: client, root: .ticket(key: "K-1"), path: "x")
        await loader.load()
        guard case let .error(e) = loader.file else { Issue.record("expected an error"); return }
        #expect(e.status == nil)
    }

    @Test func aSlowEarlierLoadDoesNotOverwriteALaterOne() async {
        let client = FakeClient()
        let slow = client.pendingFile()
        client.file(Self.view(contents: "new\n"))
        let loader = FileViewerLoader(client: client, root: .ticket(key: "K-1"), path: "src/a.ts")
        let first = Task { await loader.load() }
        // Let the first load send its request before the second starts.
        while client.calls.withLock({ $0.count }) < 1 { await Task.yield() }
        await loader.load()
        slow.resolve(Self.view(contents: "old\n"))
        await first.value
        #expect(loader.text?.lines == ["new"])
    }
}
