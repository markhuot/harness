import Foundation

// Port of mobile/src/lib/draftSync.ts. New session's draft saving (DESIGN.md "Drafts"): the
// editor's state is a Ticket; nothing reaches the service while it's still empty, the first
// worthwhile edit POSTs the draft, and later edits go out as debounced PATCHes of only what
// changed. One request at a time, in order. A change from another device (an upsert for the saved
// key) replaces the editor's state only while it has no unsent edits: the last write wins. Moving
// the draft to another project re-keys it; the editor adopts the key the service answers with.

/// The requests a draft editor makes. Main-actor bound like `DraftSync` itself;
/// `HarnessDraftAPI` adapts a `HarnessClient`.
@MainActor
public protocol DraftAPI: AnyObject {
    func create(_ body: CreateTicketBody) async throws -> Ticket
    func update(_ key: String, _ patch: UpdateTicketBody) async throws -> Ticket
    func remove(_ key: String) async throws
    func submit(_ key: String, start: Bool) async throws -> Ticket
}

/// `DraftAPI` over the real service.
@MainActor
public final class HarnessDraftAPI: DraftAPI {
    public let client: HarnessClient
    public init(client: HarnessClient) { self.client = client }

    public func create(_ body: CreateTicketBody) async throws -> Ticket { try await client.createTicket(body) }
    public func update(_ key: String, _ patch: UpdateTicketBody) async throws -> Ticket { try await client.updateTicket(key, patch) }
    public func remove(_ key: String) async throws { _ = try await client.deleteTicket(key) }
    public func submit(_ key: String, start: Bool) async throws -> Ticket { try await client.submitTicket(key, SubmitTicketBody(start: start)) }
}

/// The errors `DraftSync` throws itself (the API's own errors go to `onError` and pass through).
public enum DraftSyncError: Error, Equatable, Sendable, LocalizedError {
    /// The last save failed, so there's nothing safe to launch or keep.
    case notSaved
    /// Closed, discarded, submitted or on its way to one of those.
    case closed
    /// Submitted before anything was saved (an empty draft).
    case noPrompt

    public var message: String {
        switch self {
        case .notSaved: "The draft couldn't be saved."
        case .closed: "This draft is closed."
        case .noPrompt: "Write a prompt first."
        }
    }

    public var errorDescription: String? { message }
}

@MainActor
public final class DraftSync {
    /// The editor's state.
    public private(set) var local: Ticket
    /// The draft as the service has it; nil until the first save.
    public private(set) var saved: Ticket?

    private let api: any DraftAPI
    private let project: (String) -> Project?
    private let settings: () -> DraftSettings?
    private let onChange: (Ticket) -> Void
    private let onSaved: ((Ticket) -> Void)?
    private let onError: (any Error) -> Void
    private let delayMs: Double
    private let timers: any Timers

    private var seq = 0
    private var sentSeq = 0
    private var inflight = 0
    private var timer: TimerHandle?
    private var chain: Task<Void, Never>?
    private var closed = false
    private var failed = false
    private var ending: Task<Void, any Error>?

    /// - Parameters:
    ///   - local: The editor's starting state: a blank draft, or the saved draft being reopened
    ///   - saved: The draft as the service has it, when reopening one
    ///   - onChange: The editor's state changed other than by `edit`: a key adopted, another device's change
    ///   - onSaved: The service answered a save with this ticket
    public init(
        api: any DraftAPI,
        local: Ticket,
        saved: Ticket? = nil,
        project: @escaping (String) -> Project?,
        settings: @escaping () -> DraftSettings?,
        onChange: @escaping (Ticket) -> Void,
        onSaved: ((Ticket) -> Void)? = nil,
        onError: @escaping (any Error) -> Void,
        delayMs: Double = 400,
        timers: any Timers = TaskTimers()
    ) {
        self.api = api
        self.local = local
        self.saved = saved
        self.project = project
        self.settings = settings
        self.onChange = onChange
        self.onSaved = onSaved
        self.onError = onError
        self.delayMs = delayMs
        self.timers = timers
    }

    /// The saved draft's key, nil until the first save
    public var key: String? { saved?.key }

    /// No edits waiting to go out (and none on their way)
    public var clean: Bool { timer == nil && inflight == 0 && seq == sentSeq }

    public var empty: Bool {
        Drafts.draftIsEmpty(local, project: project(local.projectId), settings: settings())
    }

    /// Closed, discarded, submitted or on its way to one of those
    public var isClosed: Bool { closed || ending != nil }

    /// The editor changed: remember it and save it (the first save at once, later ones debounced).
    public func edit(_ next: Ticket) {
        if closed { return }
        var next = next
        if let saved { next.key = saved.key }
        local = next
        seq += 1
        if saved == nil && inflight == 0 {
            clearTimer()
            if !empty { enqueueFlush() } else { sentSeq = seq }
            return
        }
        clearTimer()
        // Strong captures, like the TS closures: a pending save still goes out if the screen lets go.
        timer = timers.set(delayMs) {
            self.timer = nil
            self.enqueueFlush()
        }
    }

    /// The store's copy of the saved draft changed (an upsert). Taken as the editor's state only
    /// while nothing is unsent and it isn't older than what we have. Returns whether it was taken.
    @discardableResult
    public func incoming(_ t: Ticket) -> Bool {
        guard !closed, let saved, clean else { return false }
        if t == saved || t.updatedAt < saved.updatedAt { return false }
        self.saved = t
        local = t
        onChange(t)
        return true
    }

    /// Send whatever hasn't gone out yet; returns once the service has it (or it failed).
    public func flush() async {
        await enqueueFlush().value
    }

    @discardableResult
    private func enqueueFlush() -> Task<Void, Never> {
        clearTimer()
        let previous = chain
        let task = Task { @MainActor in
            await previous?.value
            await self.sync()
        }
        chain = task
        return task
    }

    private func sync() async {
        if closed { return }
        let target = local
        let seq = self.seq
        let project = self.project(target.projectId)
        inflight += 1
        do {
            var t: Ticket?
            if let saved {
                if let patch = Drafts.draftPatch(saved, target) { t = try await api.update(saved.key, patch) }
            } else if let project, !Drafts.draftIsEmpty(target, project: project, settings: settings()) {
                t = try await api.create(Drafts.draftCreateBody(target, project: project))
            }
            sentSeq = seq
            failed = false
            if let t {
                saved = t
                onSaved?(t)
                if !Branches.jsEqual(local.key, t.key) {
                    local.key = t.key
                    onChange(local)
                }
            }
        } catch {
            failed = true
            onError(error)
        }
        inflight -= 1
        // Edits that came in while the request was out go next.
        if !failed && self.seq != sentSeq && timer == nil && !closed { enqueueFlush() }
    }

    /// Everything saved, or throws when the last save failed.
    private func settle() async throws {
        await flush()
        while !failed && seq != sentSeq { await flush() }
        if failed { throw DraftSyncError.notSaved }
    }

    /// Save and stop (Save draft, a swipe down). A saved draft that's empty again is deleted.
    /// Calling it again while it runs waits for the same save.
    public func close() async throws {
        if let ending { return try await ending.value }
        if closed { return }
        if saved != nil && empty { return try await discard() }
        let task = Task { @MainActor in
            defer { self.closed = true }
            try await self.settle()
        }
        ending = task
        try await task.value
    }

    /// Delete the saved draft (if any) and stop.
    public func discard() async throws {
        try await beginDiscard().value
    }

    /// `discard`, closed before it returns: the deletion runs in the returned task, and nothing
    /// (a `close` from the screen going away) can save the draft in between.
    @discardableResult
    public func beginDiscard() -> Task<Void, any Error> {
        if let ending { return ending }
        if closed { return Task {} }
        closed = true
        clearTimer()
        let previous = chain
        let task = Task { @MainActor in
            await previous?.value
            guard let saved = self.saved else { return }
            try await self.api.remove(saved.key)
        }
        ending = task
        return task
    }

    /// Save what's left, then launch it: start work now, or plan first.
    public func submit(start: Bool) async throws -> Ticket {
        if isClosed { throw DraftSyncError.closed }
        // The brief launches trimmed (a picked @mention leaves a trailing space).
        let brief = JSCompat.trim(local.description)
        if !Branches.jsEqual(brief, local.description) {
            var next = local
            next.description = brief
            edit(next)
        }
        try await settle()
        guard let saved else { throw DraftSyncError.noPrompt }
        let t = try await api.submit(saved.key, start: start)
        closed = true
        return t
    }

    /// Stop without saving (the screen is going away after a submit or discard, or failed).
    public func dispose() {
        closed = true
        clearTimer()
    }

    private func clearTimer() {
        if let timer { timers.clear(timer) }
        timer = nil
    }
}
