import Foundation
import Testing
@testable import HarnessKit

// DraftSync: syncing a new session's draft ticket with the service. A fake service records calls (each answer can be held
// back until released, or fail), and ManualTimers stands in for the debounce's real waits.

@MainActor
private enum DS {
    static func project(_ id: String, key: String, nextSeq: Int) -> Project {
        Project(id: id, key: key, name: key.lowercased(), path: "/\(key.lowercased())", nextSeq: nextSeq, defaultDriver: nil, defaultModels: [:], useWorktrees: true, isGit: true, baseBranch: .null, createdAt: 0, updatedAt: 0)
    }

    static let projects: [String: Project] = [
        "p1": project("p1", key: "WEB", nextSeq: 4),
        "p2": project("p2", key: "API", nextSeq: 9),
    ]
    static let settings = DraftSettings(defaultDriver: "claude-code", defaultModels: [:], baseBranch: "main")

    /// Let queued main-actor work (the request chain) run.
    static func drain() async {
        for _ in 0..<50 { await Task.yield() }
    }
}

private struct Boom: Error, Equatable {}

@MainActor
private final class FakeDraftAPI: DraftAPI {
    struct Call {
        var op: String
        var key: String?
        var create: CreateTicketBody?
        var update: UpdateTicketBody?
    }

    var calls: [Call] = []
    var hold: Bool
    var fail: Bool
    private var held: [CheckedContinuation<Void, Never>] = []
    private(set) var server: Ticket?
    private var n = 4
    private var now: Double = 10

    init(hold: Bool = false, fail: Bool = false) {
        self.hold = hold
        self.fail = fail
    }

    var ops: [String] { calls.map(\.op) }

    /// Answer every held request (in order).
    func release() {
        let waiting = held
        held = []
        for c in waiting { c.resume() }
    }

    private func answer<T>(_ fn: () -> T) async throws -> T {
        if hold { await withCheckedContinuation { held.append($0) } }
        if fail { throw Boom() }
        return fn()
    }

    private func nextKey(_ projectId: String) -> String {
        defer { n += 1 }
        return "\(DS.projects[projectId]!.key)-\(n)"
    }

    private func stamp() -> Double {
        defer { now += 1 }
        return now
    }

    func create(_ body: CreateTicketBody) async throws -> Ticket {
        calls.append(Call(op: "create", create: body))
        return try await answer {
            var t = Drafts.blankDraftTicket(project: DS.projects[body.projectId]!, settings: DS.settings, key: nextKey(body.projectId))
            t.id = "t1"
            t.spec = body.spec
            t.kind = body.kind ?? .task
            t.skipAgentReview = body.skipAgentReview == true
            t.skipHumanReview = body.skipHumanReview == true
            t.updatedAt = stamp()
            server = t
            return t
        }
    }

    func update(_ key: String, _ patch: UpdateTicketBody) async throws -> Ticket {
        calls.append(Call(op: "update", key: key, update: patch))
        return try await answer {
            var t = Drafts.applyTicketPatch(server!, patch)
            if let projectId = patch.projectId { t.key = nextKey(projectId) }
            t.updatedAt = stamp()
            server = t
            return t
        }
    }

    func remove(_ key: String) async throws {
        calls.append(Call(op: "remove", key: key))
        try await answer { () }
    }

    func submit(_ key: String, start: Bool) async throws -> Ticket {
        calls.append(Call(op: start ? "start" : "plan", key: key))
        return try await answer {
            var t = server!
            t.draft = false
            t.status = start ? .inProgress : .planning
            return t
        }
    }
}

@MainActor
private final class DraftSyncRecorder {
    var changes: [Ticket] = []
    var errors: [any Error] = []
}

@MainActor
private final class Harness {
    let sync: DraftSync
    let timers = ManualTimers()
    private let recorder = DraftSyncRecorder()
    var changes: [Ticket] { recorder.changes }
    var errors: [any Error] { recorder.errors }

    init(_ api: FakeDraftAPI, saved: Ticket? = nil) {
        let local = saved ?? Drafts.blankDraftTicket(project: DS.projects["p1"]!, settings: DS.settings, key: "WEB-4", now: 1)
        let recorder = recorder
        sync = DraftSync(
            api: api, local: local, saved: saved,
            project: { DS.projects[$0] }, settings: { DS.settings },
            onChange: { recorder.changes.append($0) }, onError: { recorder.errors.append($0) },
            delayMs: 20, timers: timers
        )
    }

    func edit(_ patch: UpdateTicketBody) {
        sync.edit(Drafts.applyTicketPatch(sync.local, patch))
    }

    /// Waits `ms` of debounce time: move the clock, then let the requests it started run.
    func wait(_ ms: Double) async {
        timers.advance(by: ms)
        await DS.drain()
    }
}

@MainActor
@Suite("DraftSync")
struct DraftSyncTests {
    @Test func nothingIsSentWhileEmptyAndTheFirstRealEditCreatesAtOnce() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "   "))
        await h.wait(40)
        #expect(f.calls.isEmpty)
        #expect(h.sync.clean)
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await DS.drain()
        #expect(f.ops == ["create"])
        let body = f.calls.first?.create
        #expect(body?.draft == true)
        #expect(body?.spec == "Fix it")
        #expect(body?.projectId == "p1")
        #expect(h.sync.key == "WEB-4")
        // The first save went out with no timer.
        #expect(h.timers.count == 0)
    }

    @Test func editsBeforeTheCreateGoesOutRideAlongInIt() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix"))
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await h.sync.flush()
        #expect(f.ops == ["create"])
        #expect(f.calls.first?.create?.spec == "Fix it")
    }

    @Test func laterEditsAreDebouncedIntoOnePatchOfOnlyWhatChanged() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix"))
        await DS.drain()
        h.edit(UpdateTicketBody(spec: "Fix it"))
        h.edit(UpdateTicketBody(spec: "Fix it now"))
        h.edit(UpdateTicketBody(skipAgentReview: true))
        await DS.drain()
        #expect(f.calls.count == 1)
        #expect(!h.sync.clean)
        await h.wait(40)
        #expect(f.ops == ["create", "update"])
        #expect(f.calls[1].update == UpdateTicketBody(spec: "Fix it now", skipAgentReview: true))
        #expect(h.sync.clean)
    }

    @Test func eachEditRestartsTheDebounce() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix"))
        await DS.drain()
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await h.wait(15)
        h.edit(UpdateTicketBody(spec: "Fix it now"))
        await h.wait(19)
        #expect(f.ops == ["create"])
        #expect(h.timers.count == 1)
        await h.wait(1)
        #expect(f.ops == ["create", "update"])
        #expect(f.calls[1].update == UpdateTicketBody(spec: "Fix it now"))
    }

    @Test func editsMadeWhileTheCreateIsOutFollowItAsAPatchNeverASecondCreate() async {
        let f = FakeDraftAPI(hold: true)
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix"))
        await DS.drain()
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await h.wait(40)
        // One request at a time: the PATCH waits behind the held create.
        #expect(f.ops == ["create"])
        f.release()
        await h.wait(40)
        f.release()
        await DS.drain()
        #expect(f.ops == ["create", "update"])
        #expect(f.calls[1].update == UpdateTicketBody(spec: "Fix it"))
        #expect(h.sync.clean)
    }

    @Test func movingToAnotherProjectAdoptsTheKeyTheServiceAnswersWith() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await DS.drain()
        h.edit(UpdateTicketBody(baseBranch: .null, branch: .null, useWorktree: .null, projectId: "p2"))
        await h.sync.flush()
        #expect(f.calls[1].op == "update")
        #expect(f.calls[1].key == "WEB-4")
        #expect(f.calls[1].update?.projectId == "p2")
        #expect(h.sync.key == "API-5")
        #expect(h.sync.local.key == "API-5")
        #expect(h.changes.last?.key == "API-5")
        // The next PATCH goes to the new key.
        h.edit(UpdateTicketBody(spec: "Fix it there"))
        await h.sync.flush()
        #expect(f.calls[2].key == "API-5")
        #expect(f.calls[2].update?.spec == "Fix it there")
    }

    @Test func anotherDevicesChangeAppliesOnlyWhileNothingIsUnsentAndNeverAnOlderCopy() async throws {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await DS.drain()
        var theirs = try #require(f.server)
        theirs.spec = "Their words"
        theirs.updatedAt = 100
        h.edit(UpdateTicketBody(spec: "Mine"))
        #expect(h.sync.incoming(theirs) == false)
        #expect(h.sync.local.spec == "Mine")
        await h.sync.flush()
        var older = theirs
        older.updatedAt = 1
        #expect(h.sync.incoming(older) == false)
        #expect(h.sync.incoming(theirs) == true)
        #expect(h.sync.local.spec == "Their words")
        #expect(h.changes.last?.spec == "Their words")
    }

    @Test func incomingIsIgnoredBeforeTheFirstSaveAndAfterClosing() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        var t = h.sync.local
        t.spec = "Elsewhere"
        t.updatedAt = 100
        #expect(h.sync.incoming(t) == false)
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await DS.drain()
        h.sync.dispose()
        var later = f.server!
        later.updatedAt = 100
        #expect(h.sync.incoming(later) == false)
        #expect(h.changes.isEmpty)
    }

    @Test func submitSavesWhatsPendingFirstThenLaunchesTheSavedKey() async throws {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix"))
        await DS.drain()
        h.edit(UpdateTicketBody(spec: "Fix it"))
        let t = try await h.sync.submit(start: false)
        #expect(f.ops == ["create", "update", "plan"])
        #expect(f.calls[2].key == "WEB-4")
        #expect(t.status == .planning)
        #expect(h.sync.isClosed)
        h.edit(UpdateTicketBody(spec: "after"))
        await h.wait(40)
        #expect(f.calls.count == 3)
    }

    @Test func submitLaunchesTheBriefTrimmed() async throws {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Summarize @README.md "))
        await DS.drain()
        _ = try await h.sync.submit(start: true)
        #expect(f.ops == ["create", "update", "start"])
        #expect(f.calls[1].update == UpdateTicketBody(spec: "Summarize @README.md"))
    }

    @Test func submitRefusesWhenASaveFailedInsteadOfLaunchingStaleSettings() async {
        let f = FakeDraftAPI(fail: true)
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await #expect(throws: DraftSyncError.notSaved) { _ = try await h.sync.submit(start: true) }
        #expect(DraftSyncError.notSaved.localizedDescription == "The draft couldn't be saved.")
        #expect(!h.errors.isEmpty)
        #expect(h.errors.first is Boom)
        #expect(!f.ops.contains("start"))
    }

    @Test func submitWithoutAPromptAsksForOne() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "  "))
        await #expect(throws: DraftSyncError.noPrompt) { _ = try await h.sync.submit(start: true) }
        #expect(DraftSyncError.noPrompt.localizedDescription == "Write a prompt first.")
        #expect(f.calls.isEmpty)
    }

    @Test func submitAfterClosingIsRefused() async throws {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix it"))
        try await h.sync.close()
        await #expect(throws: DraftSyncError.closed) { _ = try await h.sync.submit(start: true) }
        #expect(DraftSyncError.closed.localizedDescription == "This draft is closed.")
        #expect(f.ops == ["create"])
    }

    @Test func closingSavesPendingEditsAndASavedDraftEmptiedAgainIsDeletedInstead() async throws {
        let f = FakeDraftAPI()
        let a = Harness(f)
        a.edit(UpdateTicketBody(spec: "Fix"))
        await DS.drain()
        a.edit(UpdateTicketBody(spec: "Fix it"))
        try await a.sync.close()
        #expect(f.ops == ["create", "update"])
        #expect(a.sync.isClosed)

        let g = FakeDraftAPI()
        let b = Harness(g)
        b.edit(UpdateTicketBody(spec: "Fix"))
        await DS.drain()
        b.edit(UpdateTicketBody(spec: ""))
        try await b.sync.close()
        #expect(g.ops == ["create", "remove"])
        #expect(g.calls[1].key == "WEB-4")
    }

    @Test func discardingAnUnsavedDraftSendsNothingAndAReopenedOneIsDeletedByItsKey() async throws {
        let f = FakeDraftAPI()
        try await Harness(f).sync.discard()
        #expect(f.calls.isEmpty)
        var saved = Drafts.blankDraftTicket(project: DS.projects["p1"]!, settings: DS.settings, key: "WEB-2", now: 1)
        saved.spec = "Old"
        let r = Harness(f, saved: saved)
        r.edit(UpdateTicketBody(spec: "Old, edited"))
        try await r.sync.discard()
        #expect(f.ops == ["remove"])
        #expect(f.calls.first?.key == "WEB-2")
        // The pending debounced PATCH never goes out.
        await r.wait(40)
        #expect(f.ops == ["remove"])
    }

    @Test func discardWaitsForTheCreateInFlightAndDeletesWhatItMade() async throws {
        let f = FakeDraftAPI(hold: true)
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix it"))
        await DS.drain()
        async let done: Void = h.sync.discard()
        await DS.drain()
        #expect(f.ops == ["create"])
        f.release()
        await DS.drain()
        f.release()
        try await done
        #expect(f.ops == ["create", "remove"])
        #expect(f.calls[1].key == "WEB-4")
    }

    @Test func disposeDropsThePendingSave() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix"))
        await DS.drain()
        h.edit(UpdateTicketBody(spec: "Fix it"))
        h.sync.dispose()
        #expect(h.timers.count == 0)
        await h.wait(40)
        #expect(f.ops == ["create"])
        #expect(h.sync.isClosed)
    }

    @Test func anyOverrideIsWorthSaving() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        #expect(h.sync.empty)
        #expect(h.sync.key == nil)
        h.edit(UpdateTicketBody(skipAgentReview: true))
        #expect(!h.sync.empty)
        await DS.drain()
        #expect(f.ops == ["create"])
        #expect(f.calls.first?.create?.skipAgentReview == true)
    }

    @Test func skippingTheHumanReviewIsWorthSavingAndOnlyPatchesWhenItFlips() async {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(skipHumanReview: true))
        #expect(!h.sync.empty)
        await DS.drain()
        #expect(f.ops == ["create"])
        #expect(f.calls.first?.create?.skipHumanReview == true)
        // Both switches always go, so the service never fills in the project's defaults on its own.
        #expect(f.calls.first?.create?.skipAgentReview == false)
        h.edit(UpdateTicketBody(skipHumanReview: true))
        await h.wait(40)
        #expect(f.ops == ["create"])
        h.edit(UpdateTicketBody(skipHumanReview: false))
        await h.wait(40)
        #expect(f.ops == ["create", "update"])
        #expect(f.calls[1].update == UpdateTicketBody(skipHumanReview: false))
    }

    @Test func saveDraftThenTheSheetsCloseShareOneSave() async throws {
        let f = FakeDraftAPI()
        let h = Harness(f)
        h.edit(UpdateTicketBody(spec: "Fix"))
        await DS.drain()
        h.edit(UpdateTicketBody(spec: "Fix it"))
        async let a: Void = h.sync.close()
        async let b: Void = h.sync.close()
        _ = try await (a, b)
        #expect(f.ops == ["create", "update"])
        #expect(h.sync.isClosed)
    }
}
