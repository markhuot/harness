import Foundation
import Observation

// New session's editor state (mobile/src/screens/NewSession.tsx), without the drawing: when the
// editor can start (a project, or the reopened draft), the draft's DraftSync, what another
// device's change to the saved draft means for the sheet (adopt it, it was discarded, it was
// launched), the project switch, the submit gate and the Cancel decision. The SwiftUI screen
// (Features/NewSession) feeds it the store's state and acts on what it returns.

@MainActor
@Observable
public final class NewSessionEditor {
    /// What `begin` found.
    public enum Begin: Equatable, Sendable {
        /// The store doesn't have what the editor needs yet (the reopened draft, or any project).
        case waiting
        /// The editor has its state (now or earlier).
        case started
        /// The reopened key is a launched ticket, not a draft: show the ticket instead.
        case redirect(key: String)
    }

    /// What a change in the store's copy of the saved draft means for the sheet.
    public enum StoreOutcome: Equatable, Sendable {
        /// Nothing for the sheet to do (no saved draft yet, unsent edits, our own save).
        case none
        /// Another device's edit became the editor's state.
        case adopted
        /// The draft is gone from the store: discarded on another device. Toast and dismiss.
        case discarded
        /// The draft was launched elsewhere. Dismiss and push it.
        case launched(key: String)
    }

    /// What Cancel does.
    public enum CancelStep: Equatable, Sendable {
        /// Nothing to keep or delete: just dismiss.
        case dismiss
        /// An empty draft: discard it (deleting a saved one) and dismiss.
        case discardAndDismiss
        /// Ask: Save draft, Discard draft, or Keep editing.
        case ask
    }

    public enum Busy: Equatable, Sendable {
        case start, plan
    }

    /// The `?key=` being reopened, nil for a new session.
    public let reopen: String?
    /// The editor's state; nil until `begin` starts it.
    public private(set) var local: Ticket?
    /// The saved draft's ticket id, nil until the first save (or the reopened draft's).
    public private(set) var savedId: String?
    /// Which submit button is working.
    public private(set) var busy: Busy?

    @ObservationIgnored public private(set) var sync: DraftSync?
    @ObservationIgnored private let api: any DraftAPI
    @ObservationIgnored private let state: () -> BoardState
    @ObservationIgnored private let onSaved: (Ticket) -> Void
    @ObservationIgnored private let onError: (any Error) -> Void
    @ObservationIgnored private let delayMs: Double
    @ObservationIgnored private let timers: any Timers
    /// The store has shown the saved draft at least once (so its absence later means it's gone).
    @ObservationIgnored private var seen = false
    /// A submit is out, or launched: the store's copy turning into a launched ticket is ours.
    @ObservationIgnored private var submitting = false

    /// - Parameters:
    ///   - state: The store's current state (read whenever a project or the settings are needed)
    ///   - onSaved: The service answered a save with this ticket (dispatch it to the store)
    ///   - onError: A save failed
    public init(
        reopen: String?,
        api: any DraftAPI,
        state: @escaping () -> BoardState,
        onSaved: @escaping (Ticket) -> Void,
        onError: @escaping (any Error) -> Void,
        delayMs: Double = 400,
        timers: any Timers = TaskTimers()
    ) {
        self.reopen = reopen.flatMap { $0.isEmpty ? nil : $0 }
        self.api = api
        self.state = state
        self.onSaved = onSaved
        self.onError = onError
        self.delayMs = delayMs
        self.timers = timers
    }

    /// The project the draft is in.
    public func project(_ s: BoardState) -> Project? {
        local.flatMap { s.projects[$0.projectId] }
    }

    /// Start the editor once the store has what it needs: the reopened draft, or a project
    /// (composerProject of the route's project, then `candidates`: the board's, the last used).
    @discardableResult
    public func begin(projectId: String?, candidates: [String?]) -> Begin {
        if sync != nil { return .started }
        let s = state()
        let start: Ticket
        if let reopen {
            guard let stored = s.ticketByKey(reopen) else { return .waiting }
            if stored.draft != true { return .redirect(key: stored.key) }
            start = stored
        } else {
            guard let p = s.projects[s.composerProject(projectId ?? "", candidates: candidates)] else { return .waiting }
            start = Drafts.blankDraftTicket(project: p, settings: s.settings.map(DraftSettings.init), key: Self.predictedKey(p, in: s))
        }
        let state = state
        sync = DraftSync(
            api: api,
            local: start,
            saved: reopen == nil ? nil : start,
            project: { state().projects[$0] },
            settings: { state().settings.map(DraftSettings.init) },
            onChange: { [weak self] in self?.local = $0 },
            onSaved: { [weak self] t in
                self?.savedId = t.id
                self?.onSaved(t)
            },
            onError: { [weak self] in self?.onError($0) },
            delayMs: delayMs,
            timers: timers
        )
        if reopen != nil { savedId = start.id }
        local = start
        return .started
    }

    /// The project's next key that no ticket in the store has.
    static func predictedKey(_ p: Project, in s: BoardState) -> String {
        Branches.predictedTicketKey(p) { s.ticketByKey($0) != nil }
    }

    /// The editor's state as shown: until it's saved, the key (harness/<key>) is the project's next one.
    public func view(_ s: BoardState) -> Ticket? {
        guard var t = local else { return nil }
        if savedId == nil, let p = s.projects[t.projectId] { t.key = Self.predictedKey(p, in: s) }
        return t
    }

    /// The store changed: react to its copy of the saved draft (another device's edit, launch or discard).
    public func storeChanged(_ s: BoardState) -> StoreOutcome {
        guard let sync, let savedId, !submitting, !sync.isClosed else { return .none }
        guard let t = s.tickets[savedId] else {
            if seen && s.ready {
                sync.dispose()
                return .discarded
            }
            return .none
        }
        seen = true
        if t.draft != true {
            sync.dispose()
            return .launched(key: t.key)
        }
        return sync.incoming(t) ? .adopted : .none
    }

    /// An edit from the form: applied to the editor's state and saved.
    public func edit(_ patch: UpdateTicketBody) {
        guard let sync else { return }
        sync.edit(Drafts.applyTicketPatch(sync.local, patch))
        local = sync.local
    }

    /// The prompt changed.
    public func setPrompt(_ text: String) {
        guard let local, local.description != text else { return }
        edit(UpdateTicketBody(description: text))
    }

    /// Move the draft to another project: its branch picks start over, and a Default model keeps
    /// following the project it's in.
    public func changeProject(_ id: String) {
        guard let sync else { return }
        let s = state()
        guard let next = s.projects[id], id != sync.local.projectId else { return }
        var patch = UpdateTicketBody(baseBranch: .null, branch: .null, useWorktree: .null, projectId: id)
        let settings = s.settings.map(ModelSettings.init)
        let current = s.projects[sync.local.projectId].map(ModelProject.init)
        if Models.ticketChoice(sync.local, current, settings).driver == nil {
            let model = Models.ticketChoicePatch(Watchers.defaultTriageChoice, ModelProject(next), settings)
            patch.driver = model.driver
            patch.model = model.model
        }
        edit(patch)
    }

    /// The driver the session will run with (nil: the project's default), for its /commands.
    public func commandDriver(_ s: BoardState) -> String? {
        guard let local, let p = project(s) else { return nil }
        return Models.ticketChoice(local, ModelProject(p), s.settings.map(ModelSettings.init)).driver
    }

    /// Start session / Plan first (and the toolbar's Start) are enabled: a prompt, a project,
    /// nothing in flight, and a branch pick that isn't an error.
    public func canSubmit(_ s: BoardState, hint: BranchHint?) -> Bool {
        guard let local, project(s) != nil, busy == nil else { return false }
        return !JSCompat.trim(local.description).isEmpty && hint?.tone != .error
    }

    /// Launch the draft: start work now, or plan first. Throws what the save or the submit threw
    /// (the editor stays open and usable then).
    public func submit(start: Bool) async throws -> Ticket {
        guard let sync else { throw DraftSyncError.noPrompt }
        busy = start ? .start : .plan
        submitting = true
        defer { busy = nil }
        do {
            return try await sync.submit(start: start)
        } catch {
            submitting = false
            throw error
        }
    }

    /// What Cancel does now.
    public var cancelStep: CancelStep {
        guard let sync else { return .dismiss }
        return sync.empty ? .discardAndDismiss : .ask
    }

    /// Delete the saved draft (if any) and stop.
    public func discard() async throws {
        try await sync?.discard()
    }

    /// Save what's unsent and stop (a saved draft that's empty again is deleted).
    public func save() async throws {
        try await sync?.close()
    }

    /// The sheet went away (a swipe down, a link, a reconnect): save the draft unless Cancel,
    /// a submit or another device already settled it.
    public func screenGone() {
        guard let sync, !sync.isClosed else { return }
        Task { try? await sync.close() }
    }
}
