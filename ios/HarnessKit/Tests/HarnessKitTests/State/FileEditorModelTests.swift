import Foundation
import Synchronization
import Testing
@testable import HarnessKit

@MainActor
@Suite struct FileEditorModelTests {
    /// Records writes; each waits on a gate while `hold` is set, and fails with `failure` when given.
    final class WriteClient: FileViewerClient, @unchecked Sendable {
        let writes = Mutex<[String]>([])
        let failure = Mutex<(any Error)?>(nil)
        let gates = Mutex<[Deferred<Void>]>([])

        func ticketFile(_ key: String, path: String) async throws -> FileView { fatalError() }
        func projectFile(_ id: String, path: String) async throws -> FileView { fatalError() }
        func ticketFileDiff(_ key: String, path: String) async throws -> FileDiff { fatalError() }
        func projectFileDiff(_ id: String, path: String) async throws -> FileDiff { fatalError() }

        func writeTicketFile(_ key: String, path: String, contents: String) async throws -> FileWriteResult {
            try await write("ticket \(key) \(path) \(contents)", contents)
        }

        func writeProjectFile(_ id: String, path: String, contents: String) async throws -> FileWriteResult {
            try await write("project \(id) \(path) \(contents)", contents)
        }

        private func write(_ record: String, _ contents: String) async throws -> FileWriteResult {
            let gate = gates.withLock { $0.isEmpty ? nil : $0.removeFirst() }
            try await gate?.value()
            if let e = failure.withLock({ $0 }) { throw e }
            writes.withLock { $0.append(record) }
            return FileWriteResult(path: "a", size: contents.utf8.count)
        }
    }

    func model(_ client: WriteClient, root: FileRoot = .ticket(key: "T-1")) -> FileEditorModel {
        let m = FileEditorModel(client: client, root: root, path: "src/a.ts")
        m.opened("one")
        return m
    }

    @Test func savesTheNewestContentsToTheTicketOrProjectRoot() async {
        let client = WriteClient()
        let m = model(client)
        m.edited(contents: "two", dirty: true)
        #expect(await m.save() == "two")
        let p = model(client, root: .project(id: "p9"))
        p.edited(contents: "three", dirty: true)
        _ = await p.save()
        #expect(client.writes.withLock { $0 } == ["ticket T-1 src/a.ts two", "project p9 src/a.ts three"])
        #expect(!m.dirty && !m.saving && m.saveError == nil)
        #expect(m.saved == "two")
    }

    @Test func aFailedSaveStaysDirtyAndSaysWhy() async {
        let client = WriteClient()
        client.failure.withLock { $0 = HarnessAPIError(status: 507, message: "Disk full") }
        let m = model(client)
        m.edited(contents: "two", dirty: true)
        #expect(await m.save() == nil)
        #expect(m.dirty)
        #expect(m.saved == "one")
        #expect(m.saveError?.contains("Disk full") == true)
        client.failure.withLock { $0 = nil }
        #expect(await m.save() == "two")
        #expect(m.saveError == nil)
    }

    @Test func editsAFailedLeaveSaveKeptComeBackDirtyAndSaveable() async {
        let client = WriteClient()
        client.failure.withLock { $0 = HarnessAPIError(status: 507, message: "Disk full") }
        let m = model(client)
        m.edited(contents: "two", dirty: true)
        #expect(await m.save() == nil)
        // The screen goes away: what it holds is kept for the file's next screen.
        let kept = UnsavedEdits()
        kept.keep(m.root, path: m.path, contents: m.latest ?? "", saved: m.saved, error: m.saveError)
        #expect(!kept.has(.ticket(key: "T-2"), path: "src/a.ts"))
        #expect(!kept.has(.project(id: "T-1"), path: "src/a.ts"))
        let entry = kept.take(.ticket(key: "T-1"), path: "src/a.ts")
        #expect(kept.take(.ticket(key: "T-1"), path: "src/a.ts") == nil)
        let reopened = FileEditorModel(client: client, root: .ticket(key: "T-1"), path: "src/a.ts")
        reopened.restored(try! #require(entry))
        #expect(reopened.dirty && reopened.latest == "two" && reopened.saved == "one")
        #expect(reopened.saveError?.contains("Disk full") == true)
        client.failure.withLock { $0 = nil }
        #expect(await reopened.save() == "two")
        #expect(!reopened.dirty && reopened.saveError == nil)
        #expect(client.writes.withLock { $0 } == ["ticket T-1 src/a.ts two"])
    }

    @Test func typingDuringASaveLeavesTheEditorDirty() async {
        let client = WriteClient()
        let gate = Deferred<Void>()
        client.gates.withLock { $0.append(gate) }
        let m = model(client)
        m.edited(contents: "two", dirty: true)
        let saving = Task { await m.save() }
        await Task.yield()
        m.edited(contents: "two!", dirty: true)
        gate.resolve(())
        #expect(await saving.value == "two")
        // "two" is on disk; the document moved on.
        #expect(m.dirty)
        #expect(m.latest == "two!")
        #expect(m.saved == "two")
    }

    @Test func savesLandInTheOrderTheyWereAsked() async {
        let client = WriteClient()
        let gate = Deferred<Void>()
        client.gates.withLock { $0.append(gate) }
        let m = model(client)
        let first = Task { await m.save("first") }
        await Task.yield()
        let second = Task { await m.save("second") }
        await Task.yield()
        #expect(client.writes.withLock { $0 }.isEmpty)
        gate.resolve(())
        _ = await first.value
        _ = await second.value
        #expect(client.writes.withLock { $0 } == ["ticket T-1 src/a.ts first", "ticket T-1 src/a.ts second"])
        #expect(!m.saving)
    }

    @Test func nothingToSaveBeforeTheEditorOpens() async {
        let client = WriteClient()
        let m = FileEditorModel(client: client, root: .ticket(key: "T-1"), path: "a")
        #expect(await m.save() == nil)
        #expect(client.writes.withLock { $0 }.isEmpty)
    }

    @Test func reopeningClearsDirtyAndTheError() {
        let m = model(WriteClient())
        m.edited(contents: "x", dirty: true)
        m.opened("fresh")
        #expect(!m.dirty && m.latest == "fresh" && m.saveError == nil)
    }

    @Test func theRevisionMovesWhenTheEditorTypesOrSaves() async {
        let m = model(WriteClient())
        let opened = m.revision
        m.edited(contents: "two", dirty: true)
        #expect(m.revision != opened)
        let typed = m.revision
        _ = await m.save()
        #expect(m.revision != typed)
        let saved = m.revision
        m.opened("fresh")
        #expect(m.revision != saved)
    }

    @Test func aFailedSaveLeavesTheRevisionAlone() async {
        let client = WriteClient()
        client.failure.withLock { $0 = HarnessAPIError(status: 500, message: "no") }
        let m = model(client)
        m.edited(contents: "two", dirty: true)
        let before = m.revision
        _ = await m.save()
        #expect(m.revision == before)
    }
}
