import Foundation
import Synchronization
import Testing
@testable import HarnessKit

@MainActor
@Suite struct ChangesStoreTests {
    /// Answers every request from settable values and counts them.
    final class FakeChangesSource: ChangesSource {
        struct State {
            var changes: Result<Changes, any Error> = .failure(URLError(.notConnectedToInternet))
            var contents: String? = nil
            var changesCalls = 0
            var fileCalls: [String] = []
            /// Requests park here until released, when set
            var gate: Deferred<Void>?
        }

        let state = Mutex(State())

        func set(_ c: Changes) { state.withLock { $0.changes = .success(c) } }
        func fail(_ e: any Error) { state.withLock { $0.changes = .failure(e) } }
        var changesCalls: Int { state.withLock { $0.changesCalls } }

        func changes(ticket: String, maxBytes: Int?) async throws -> Changes {
            let gate = state.withLock { s -> Deferred<Void>? in
                s.changesCalls += 1
                return s.gate
            }
            if let gate { try await gate.value() }
            return try state.withLock { $0.changes }.get()
        }

        func log(ticket: String, limit: Int?) async throws -> ChangesLog { ChangesLog(mode: .branch, base: "main", commits: []) }

        func file(ticket: String, side: ChangesSide, path: String, ref: String?) async throws -> String? {
            state.withLock {
                $0.fileCalls.append("\(side.rawValue):\(path):\(ref ?? "-")")
                return $0.contents
            }
        }
    }

    static func changes(_ patch: String, files: [ChangedFile]) -> Changes {
        Changes(mode: .branch, base: "main", baseSha: "base", head: "head", branch: "b", files: files, patch: patch, additions: 0, deletions: 0)
    }

    static let a1 = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n"
    static let a2 = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+c\n"
    static let b1 = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -5,1 +5,1 @@\n-x\n+y\n"
    static let fileA = ChangedFile(path: "a.ts", status: .modified, additions: 1, deletions: 1)
    static let fileB = ChangedFile(path: "b.ts", status: .modified, additions: 1, deletions: 1)

    func make(_ source: FakeChangesSource, defaults: MemoryChangesDefaults = MemoryChangesDefaults(), timers: ManualTimers = ManualTimers()) -> ChangesStore {
        ChangesStore(ticketKey: "G-1", source: source, defaults: defaults, timers: timers, now: { 42 })
    }

    @Test func aRefreshDuringALoadRunsOnceMoreAfterIt() async {
        let source = FakeChangesSource()
        let gate = Deferred<Void>()
        source.state.withLock { $0.gate = gate }
        source.set(Self.changes(Self.a1, files: [Self.fileA]))
        let store = make(source)
        let first = store.refresh()
        #expect(store.loading)
        #expect(store.refresh() == nil)
        #expect(store.refresh() == nil)
        gate.resolve(())
        await first?.value
        #expect(source.changesCalls == 2)
        #expect(!store.loading)
        #expect(store.fingerprints.keys.sorted() == ["a.ts"])
    }

    @Test func aFailedRefreshKeepsWhatWasShown() async {
        let source = FakeChangesSource()
        source.set(Self.changes(Self.a1, files: [Self.fileA]))
        let store = make(source)
        await store.refresh()?.value
        source.fail(HarnessAPIError(status: 409, message: "G-1 has no workdir yet"))
        await store.refresh()?.value
        #expect(store.changes?.files == [Self.fileA])
        #expect(store.error == "G-1 has no workdir yet")
        #expect(ChangesRows.notices(store.changes, error: store.error) == ["Refresh failed: G-1 has no workdir yet"])
    }

    @Test func ticketEventsDebounceAndBusyTicketsPoll() async {
        let source = FakeChangesSource()
        source.set(Self.changes(Self.a1, files: [Self.fileA]))
        let timers = ManualTimers()
        let store = make(source, timers: timers)
        store.ticketChanged(busy: false)
        timers.advance(by: 500)
        store.ticketChanged(busy: false)
        timers.advance(by: 500)
        #expect(source.changesCalls == 0)
        timers.advance(by: 100)
        await settle()
        #expect(source.changesCalls == 1)

        store.ticketChanged(busy: true)
        #expect(timers.delays == [ChangesStore.debounceMs, ChangesStore.pollMs])
        timers.advance(by: ChangesStore.debounceMs)
        await settle()
        timers.advance(by: ChangesStore.pollMs - ChangesStore.debounceMs)
        await settle()
        #expect(source.changesCalls == 3)
        #expect(timers.delays == [ChangesStore.pollMs])

        // Off screen: no polling; back on screen: refresh at once and poll again.
        store.setActive(false)
        #expect(timers.count == 0)
        store.setActive(true)
        await settle()
        #expect(source.changesCalls == 4)
        #expect(timers.delays == [ChangesStore.pollMs])

        store.ticketChanged(busy: false)
        #expect(timers.delays == [ChangesStore.debounceMs])
        store.stop()
        #expect(timers.count == 0)
    }

    @Test func viewedMarksFollowTheFingerprint() async {
        let source = FakeChangesSource()
        let defaults = MemoryChangesDefaults()
        source.set(Self.changes(Self.a1 + Self.b1, files: [Self.fileA, Self.fileB]))
        let store = make(source, defaults: defaults)
        await store.refresh()?.value
        store.setViewed("a.ts", true)
        store.setViewed("b.ts", true)
        #expect(store.viewedCount == 2)
        #expect(store.isCollapsed("a.ts"))
        #expect(ChangesViewedStore.read("G-1", from: defaults).count == 2)

        // The agent edits a.ts again: it reads as unviewed and opens; b.ts keeps its mark.
        source.set(Self.changes(Self.a2 + Self.b1, files: [Self.fileA, Self.fileB]))
        await store.refresh()?.value
        #expect(!store.isViewed("a.ts") && !store.isCollapsed("a.ts"))
        #expect(store.isViewed("b.ts"))
        #expect(ChangesViewedStore.read("G-1", from: defaults).entries.map(\.path) == ["b.ts"])

        // A new store for the same ticket (the tab reopened) reads the marks back.
        let again = make(source, defaults: defaults)
        await again.refresh()?.value
        #expect(again.isViewed("b.ts") && again.viewedCount == 1)
    }

    @Test func theDisclosureArrowOverridesViewedForThisVersionOnly() async {
        let source = FakeChangesSource()
        source.set(Self.changes(Self.a1, files: [Self.fileA]))
        let store = make(source)
        await store.refresh()?.value
        store.setViewed("a.ts", true)
        store.toggleCollapsed("a.ts")
        #expect(store.isViewed("a.ts") && !store.isCollapsed("a.ts"))
        // Unviewing then viewing again resets the arrow.
        store.setViewed("a.ts", false)
        store.setViewed("a.ts", true)
        #expect(store.isCollapsed("a.ts"))
        store.toggleCollapsed("a.ts")
        source.set(Self.changes(Self.a2, files: [Self.fileA]))
        await store.refresh()?.value
        #expect(!store.isCollapsed("a.ts"))
        store.setViewed("a.ts", true)
        #expect(store.isCollapsed("a.ts"))
    }

    @Test func expandingLoadsTheNewSideOnceAndForgetsItWhenTheDiffChanges() async {
        let source = FakeChangesSource()
        source.state.withLock { $0.contents = (1...8).map { "l\($0)" }.joined(separator: "\n") + "\n" }
        source.set(Self.changes(Self.b1, files: [Self.fileB]))
        let store = make(source)
        await store.refresh()?.value
        await store.expand("b.ts", gap: 0)?.value
        #expect(source.state.withLock { $0.fileCalls } == ["new:b.ts:-"])
        let shown = store.rows("b.ts").compactMap { if case let .line(l) = $0 { l.newLine } else { nil } }
        #expect(shown == [1, 2, 3, 4, 5])
        #expect(store.expand("b.ts", gap: 1) == nil)
        #expect(store.rows("b.ts").compactMap { if case let .line(l) = $0 { l.newLine } else { nil } }.suffix(3) == [6, 7, 8])
        #expect(source.state.withLock { $0.fileCalls.count } == 1)

        source.set(Self.changes(Self.a1 + Self.b1.replacingOccurrences(of: "+y", with: "+z"), files: [Self.fileA, Self.fileB]))
        await store.refresh()?.value
        #expect(store.contents["b.ts"] == nil && store.expanded["b.ts"] == nil)
    }

    @Test func styleChoiceIsSaved() {
        let defaults = MemoryChangesDefaults()
        let store = make(FakeChangesSource(), defaults: defaults)
        #expect(store.chosenStyle == nil && store.style(width: 400) == .unified)
        store.setStyle(.split)
        #expect(store.style(width: 400) == .unified)
        #expect(store.style(width: 800) == .split)
        #expect(make(FakeChangesSource(), defaults: defaults).chosenStyle == .split)
    }

    /// Lets tasks the timers started run to completion.
    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }
}
