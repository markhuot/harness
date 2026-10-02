import Foundation
import Testing
@testable import HarnessKit

// New session's editor decisions (screens/NewSession.tsx): when it starts, the predicted key,
// what another device's change means, the project switch, the submit gate and Cancel. A fake
// service answers the DraftSync requests; ManualTimers stands in for the debounce.

@MainActor
@Suite("NewSessionEditor (screens/NewSession.tsx)")
struct NewSessionEditorTests {
    static func project(_ id: String, key: String, name: String, nextSeq: Int, driver: String? = nil) -> Project {
        Project(id: id, key: key, name: name, path: "/\(name)", nextSeq: nextSeq, defaultDriver: driver, defaultModels: [:], useWorktrees: true, isGit: true, requireHumanReview: true, baseBranch: .null, createdAt: 0, updatedAt: 0)
    }

    static let settings = PublicSettings(defaultDriver: "claude-code", maxConcurrentRuns: 2, permissionMode: .auto, classifier: .off, anthropicApiKeySet: false)

    /// web (WEB, next WEB-4), api (API, next API-9, pinned to codex).
    static let projects: [String: Project] = [
        "p1": project("p1", key: "WEB", name: "web", nextSeq: 4),
        "p2": project("p2", key: "API", name: "api", nextSeq: 9, driver: "codex"),
    ]

    static func drain() async {
        for _ in 0..<50 { await Task.yield() }
    }

    /// Records requests; creates answer with WEB-4 / API-9 and bump updatedAt.
    @MainActor
    final class Service: DraftAPI {
        var ops: [String] = []
        var fail = false
        var server: Ticket?
        private var now: Double = 10

        func create(_ body: CreateTicketBody) async throws -> Ticket {
            ops.append("create")
            if fail { throw HarnessAPIError(status: 500, message: "boom") }
            let p = NewSessionEditorTests.projects[body.projectId]!
            var t = Drafts.blankDraftTicket(project: p, settings: DraftSettings(NewSessionEditorTests.settings), key: "\(p.key)-\(p.nextSeq)")
            t.id = "t1"
            t.description = body.prompt
            t.updatedAt = stamp()
            server = t
            return t
        }

        func update(_ key: String, _ patch: UpdateTicketBody) async throws -> Ticket {
            ops.append("update \(key)")
            if fail { throw HarnessAPIError(status: 500, message: "boom") }
            var t = Drafts.applyTicketPatch(server!, patch)
            t.updatedAt = stamp()
            server = t
            return t
        }

        func remove(_ key: String) async throws { ops.append("remove \(key)") }

        func submit(_ key: String, start: Bool) async throws -> Ticket {
            ops.append(start ? "start \(key)" : "plan \(key)")
            if fail { throw HarnessAPIError(status: 409, message: "nope") }
            var t = server!
            t.draft = false
            return t
        }

        private func stamp() -> Double {
            defer { now += 1 }
            return now
        }
    }

    /// The store as the editor sees it, with the saves it dispatched.
    @MainActor
    final class Store {
        var state: BoardState
        var errors: [String] = []
        init(_ state: BoardState) { self.state = state }
    }

    @MainActor
    struct Rig {
        let api = Service()
        let store: Store
        let timers = ManualTimers()
        let editor: NewSessionEditor

        init(reopen: String? = nil, state: BoardState = BoardState(ready: true, projects: NewSessionEditorTests.projects, settings: NewSessionEditorTests.settings)) {
            let store = Store(state)
            self.store = store
            editor = NewSessionEditor(
                reopen: reopen, api: api, state: { store.state },
                onSaved: { store.state.tickets[$0.id] = $0 },
                onError: { store.errors.append(String(describing: $0)) },
                delayMs: 20, timers: timers
            )
        }

        func wait(_ ms: Double = 40) async {
            timers.advance(by: ms)
            await NewSessionEditorTests.drain()
        }
    }

    static func draft(key: String = "WEB-2", projectId: String = "p1", description: String = "Saved", updatedAt: Double = 5) -> Ticket {
        var t = Drafts.blankDraftTicket(project: projects[projectId]!, settings: DraftSettings(settings), key: key, now: updatedAt)
        t.id = "d1"
        t.description = description
        return t
    }

    // MARK: Starting

    @Test func waitsForAProjectThenPrefersTheRouteProjectOverTheCandidates() {
        let empty = Rig(state: BoardState(ready: true))
        #expect(empty.editor.begin(projectId: "p2", candidates: ["p1"]) == .waiting)
        #expect(empty.editor.local == nil)

        let r = Rig()
        #expect(r.editor.begin(projectId: "p2", candidates: ["p1"]) == .started)
        #expect(r.editor.local?.projectId == "p2")
        // Starting again keeps the editor's state.
        #expect(r.editor.begin(projectId: "p1", candidates: []) == .started)
        #expect(r.editor.local?.projectId == "p2")
    }

    @Test func aRouteProjectThatDoesntExistFallsBackToTheFirstCandidateThatDoes() {
        let r = Rig()
        r.editor.begin(projectId: "gone", candidates: [nil, "also-gone", "p2", "p1"])
        #expect(r.editor.local?.projectId == "p2")
    }

    @Test func thePredictedKeySkipsKeysTheStoreHasAndGivesWayToTheSavedOne() async {
        let r = Rig()
        r.store.state.tickets["x"] = Self.draft(key: "WEB-4")
        r.editor.begin(projectId: "p1", candidates: [])
        #expect(r.editor.view(r.store.state)?.key == "WEB-5")
        r.editor.setPrompt("Fix it")
        await Self.drain()
        #expect(r.api.ops == ["create"])
        // The service named it WEB-4 (the fake doesn't skip); that's the key shown now.
        #expect(r.editor.savedId == "t1")
        #expect(r.editor.view(r.store.state)?.key == "WEB-4")
    }

    @Test func reopeningWaitsForTheKeyThenEditsTheSavedDraft() {
        let r = Rig(reopen: "web-2")
        #expect(r.editor.begin(projectId: nil, candidates: []) == .waiting)
        r.store.state.tickets["d1"] = Self.draft()
        #expect(r.editor.begin(projectId: nil, candidates: []) == .started)
        #expect(r.editor.savedId == "d1")
        #expect(r.editor.view(r.store.state)?.key == "WEB-2")
        #expect(r.editor.cancelStep == .ask)
    }

    @Test func reopeningALaunchedTicketRedirectsToIt() {
        var launched = Self.draft()
        launched.draft = false
        let r = Rig(reopen: "WEB-2")
        r.store.state.tickets["d1"] = launched
        #expect(r.editor.begin(projectId: nil, candidates: []) == .redirect(key: "WEB-2"))
        #expect(r.editor.sync == nil)
    }

    // MARK: Other devices

    @Test func aDraftMissingBeforeTheStoreHasShownItIsntCalledDiscarded() {
        let r = Rig(reopen: "WEB-2")
        r.store.state.tickets["d1"] = Self.draft()
        r.editor.begin(projectId: nil, candidates: [])
        r.store.state.tickets = [:]
        #expect(r.editor.storeChanged(r.store.state) == .none)
        // Seen, then gone while the store isn't ready (a reconnect's reload): still nothing.
        r.store.state.tickets["d1"] = Self.draft()
        #expect(r.editor.storeChanged(r.store.state) == .none)
        r.store.state.tickets = [:]
        r.store.state.ready = false
        #expect(r.editor.storeChanged(r.store.state) == .none)
        r.store.state.ready = true
        #expect(r.editor.storeChanged(r.store.state) == .discarded)
        #expect(r.editor.sync?.isClosed == true)
        // A disposed editor neither reacts again nor saves on its way out.
        #expect(r.editor.storeChanged(r.store.state) == .none)
    }

    @Test func aDraftLaunchedElsewhereIsReportedWithItsKey() {
        let r = Rig(reopen: "WEB-2")
        r.store.state.tickets["d1"] = Self.draft()
        r.editor.begin(projectId: nil, candidates: [])
        var launched = Self.draft(key: "API-12", updatedAt: 9)
        launched.draft = false
        r.store.state.tickets["d1"] = launched
        #expect(r.editor.storeChanged(r.store.state) == .launched(key: "API-12"))
    }

    @Test func anotherDevicesEditIsAdoptedOnlyWithoutUnsentEdits() async {
        let r = Rig(reopen: "WEB-2")
        r.store.state.tickets["d1"] = Self.draft()
        r.editor.begin(projectId: nil, candidates: [])
        r.editor.setPrompt("Mine")
        r.store.state.tickets["d1"] = Self.draft(description: "Theirs", updatedAt: 6)
        #expect(r.editor.storeChanged(r.store.state) == .none)
        #expect(r.editor.local?.description == "Mine")

        let clean = Rig(reopen: "WEB-2")
        clean.store.state.tickets["d1"] = Self.draft()
        clean.editor.begin(projectId: nil, candidates: [])
        clean.store.state.tickets["d1"] = Self.draft(description: "Theirs", updatedAt: 6)
        #expect(clean.editor.storeChanged(clean.store.state) == .adopted)
        #expect(clean.editor.local?.description == "Theirs")
        // An older copy (a stale snapshot) doesn't win.
        clean.store.state.tickets["d1"] = Self.draft(description: "Older", updatedAt: 4)
        #expect(clean.editor.storeChanged(clean.store.state) == .none)
        #expect(clean.editor.local?.description == "Theirs")
    }

    @Test func ourOwnSaveComingBackThroughTheStoreChangesNothing() async {
        let r = Rig()
        r.editor.begin(projectId: "p1", candidates: [])
        r.editor.setPrompt("Fix it")
        await Self.drain()
        #expect(r.editor.storeChanged(r.store.state) == .none)
        #expect(r.editor.local?.description == "Fix it")
    }

    // MARK: Editing

    @Test func changingProjectResetsTheBranchPicksAndADefaultModelFollows() async {
        let r = Rig()
        r.editor.begin(projectId: "p1", candidates: [])
        r.editor.edit(UpdateTicketBody(baseBranch: Patch("dev"), branch: Patch("feature"), useWorktree: Patch(true)))
        #expect(r.editor.local?.driver == "claude-code")
        r.editor.changeProject("p2")
        let t = r.editor.local
        #expect(t?.projectId == "p2")
        #expect(t?.requestedBranch.optional == nil)
        #expect(t?.baseBranch.optional == nil)
        #expect(t?.useWorktree.optional == nil)
        // web's Default (claude-code) became api's Default (its pinned codex).
        #expect(t?.driver == "codex")
        #expect(r.editor.commandDriver(r.store.state) == nil)
    }

    @Test func changingProjectKeepsAModelPickedOnPurpose() {
        let r = Rig()
        r.editor.begin(projectId: "p1", candidates: [])
        r.editor.edit(UpdateTicketBody(driver: "dummy", model: Patch("fast")))
        #expect(r.editor.commandDriver(r.store.state) == "dummy")
        r.editor.changeProject("p2")
        #expect(r.editor.local?.driver == "dummy")
        #expect(r.editor.local?.model == "fast")
        // The same project or one that doesn't exist does nothing.
        r.editor.changeProject("missing")
        #expect(r.editor.local?.projectId == "p2")
    }

    @Test func submitNeedsAPromptAProjectAndABranchThatIsntAnError() {
        let r = Rig()
        #expect(!r.editor.canSubmit(r.store.state, hint: nil))
        r.editor.begin(projectId: "p1", candidates: [])
        r.editor.setPrompt(" \n ")
        #expect(!r.editor.canSubmit(r.store.state, hint: nil))
        r.editor.setPrompt("Go")
        #expect(r.editor.canSubmit(r.store.state, hint: nil))
        #expect(r.editor.canSubmit(r.store.state, hint: BranchHint(text: "Checked out elsewhere", tone: .warn)))
        #expect(!r.editor.canSubmit(r.store.state, hint: BranchHint(text: "Invalid", tone: .error)))
        // The project went away under it.
        r.store.state.projects = [:]
        #expect(!r.editor.canSubmit(r.store.state, hint: nil))
    }

    // MARK: Submit, Cancel, going away

    @Test func aFailedSubmitLeavesTheEditorWatchingForOtherDevices() async {
        let r = Rig(reopen: "WEB-2")
        r.store.state.tickets["d1"] = Self.draft()
        r.editor.begin(projectId: nil, candidates: [])
        _ = r.editor.storeChanged(r.store.state)
        r.api.server = Self.draft()
        r.api.fail = true
        await #expect(throws: HarnessAPIError.self) { try await r.editor.submit(start: true) }
        #expect(r.editor.busy == nil)
        #expect(r.api.ops == ["start WEB-2"])
        r.store.state.tickets = [:]
        #expect(r.editor.storeChanged(r.store.state) == .discarded)
    }

    @Test func aSubmitTrimsTheBriefAndOwnsTheLaunchTheStoreThenShows() async throws {
        let r = Rig()
        r.editor.begin(projectId: "p1", candidates: [])
        r.editor.setPrompt("Summarize @README.md ")
        await Self.drain()
        let t = try await r.editor.submit(start: false)
        #expect(t.draft == false)
        #expect(r.api.ops == ["create", "update WEB-4", "plan WEB-4"])
        #expect(r.api.server?.description == "Summarize @README.md")
        r.store.state.tickets["t1"] = t
        #expect(r.editor.storeChanged(r.store.state) == .none)
    }

    @Test func cancelDismissesWhileLoadingDiscardsAnEmptyDraftAndAsksOtherwise() async throws {
        let r = Rig(state: BoardState(ready: false))
        #expect(r.editor.cancelStep == .dismiss)

        let fresh = Rig()
        fresh.editor.begin(projectId: "p1", candidates: [])
        #expect(fresh.editor.cancelStep == .discardAndDismiss)
        fresh.editor.edit(UpdateTicketBody(kind: .conductor))
        #expect(fresh.editor.cancelStep == .ask)
        await Self.drain()
        // Back to empty after it was saved: discarding deletes it.
        fresh.editor.edit(UpdateTicketBody(kind: .task))
        #expect(fresh.editor.cancelStep == .discardAndDismiss)
        try await fresh.editor.discard().value
        #expect(fresh.api.ops == ["create", "remove WEB-4"])
    }

    @Test func goingAwaySavesUnsentEditsButNotAfterADiscard() async {
        let r = Rig(reopen: "WEB-2")
        r.store.state.tickets["d1"] = Self.draft()
        r.api.server = Self.draft()
        r.editor.begin(projectId: nil, candidates: [])
        r.editor.setPrompt("Edited")
        r.editor.screenGone()
        await Self.drain()
        #expect(r.api.ops == ["update WEB-2"])
        #expect(r.api.server?.description == "Edited")

        let gone = Rig(reopen: "WEB-2")
        gone.store.state.tickets["d1"] = Self.draft()
        gone.editor.begin(projectId: nil, candidates: [])
        gone.editor.setPrompt("Edited")
        try? await gone.editor.discard().value
        gone.editor.screenGone()
        await Self.drain()
        #expect(gone.api.ops == ["remove WEB-2"])
    }

    /// Cancel → Discard dismisses the sheet right away, so its onDisappear (`screenGone`) runs
    /// before the discard's task has: it must not save the draft first.
    @Test func goingAwayBeforeTheDiscardRunsDoesntSaveTheDraft() async {
        let r = Rig(reopen: "WEB-2")
        r.store.state.tickets["d1"] = Self.draft()
        r.api.server = Self.draft()
        r.editor.begin(projectId: nil, candidates: [])
        r.editor.setPrompt("Edited")
        let discarding = r.editor.discard()
        // Closed before the discard's task has run a step.
        #expect(r.editor.sync?.isClosed == true)
        r.editor.screenGone()
        try? await discarding.value
        await Self.drain()
        #expect(r.api.ops == ["remove WEB-2"])
    }

    @Test func aFailedSaveIsReported() async {
        let r = Rig()
        r.api.fail = true
        r.editor.begin(projectId: "p1", candidates: [])
        r.editor.setPrompt("Fix it")
        await Self.drain()
        #expect(r.store.errors.count == 1)
        #expect(r.editor.savedId == nil)
    }
}
