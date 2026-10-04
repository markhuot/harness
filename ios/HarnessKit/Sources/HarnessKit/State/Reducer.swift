import Foundation

// Port of the reducer half of shared/src/state/reducer.ts. A snapshot is authoritative for entity
// lists (except a strictly newer live version, `preferNewer`); live events and REST backfills
// merge in by id.

extension BoardState {
    // MARK: Helpers

    static func byId<T: Identifiable>(_ items: [T]) -> [String: T] where T.ID == String {
        var out: [String: T] = [:]
        for item in items { out[item.id] = item }
        return out
    }

    /// Merge entries into a list: dedupe by id (newer wins), keep sorted by `order` with an id
    /// tie-break.
    public static func mergeById<T: Identifiable>(_ existing: [T], _ incoming: [T], order: (T) -> Double) -> [T] where T.ID == String {
        if incoming.isEmpty { return existing }
        var map: [String: T] = [:]
        for e in existing { map[e.id] = e }
        for e in incoming { map[e.id] = e }
        return map.values.sorted { a, b in
            let d = order(a) - order(b)
            if d != 0 { return d < 0 }
            return JSString.less(a.id, b.id)
        }
    }

    /// Snapshot entities win, except when a live event already delivered a strictly newer version
    /// of the same entity while the REST request was in flight.
    static func preferNewer<T>(_ snap: [String: T], _ live: [String: T], updatedAt: (T) -> Double) -> [String: T] {
        var out = snap
        for (id, s) in snap {
            if let current = live[id], updatedAt(current) > updatedAt(s) { out[id] = current }
        }
        return out
    }

    /// Where a transcript lives in `transcripts`: the session's own, or one sub-agent's.
    public static func transcriptKey(_ sessionId: String, _ subagentId: String? = nil) -> String {
        if let subagentId, !subagentId.isEmpty { return "\(sessionId)/\(subagentId)" }
        return sessionId
    }

    mutating func mergeTranscript(_ key: String, _ entries: [TranscriptEntry], loaded: Bool) {
        let prev = transcripts[key] ?? TranscriptState()
        transcripts[key] = TranscriptState(
            entries: Self.mergeById(prev.entries, entries, order: { Double($0.seq) }),
            loaded: prev.loaded || loaded)
    }

    /// Merge sub-agents by id; a stale copy (older updatedAt) never replaces a newer one.
    mutating func mergeSubagents(_ sessionId: String, _ incoming: [Subagent]) {
        let prev = subagents[sessionId] ?? []
        let current = Self.byId(prev)
        let fresh = incoming.filter { s in
            guard let have = current[s.id] else { return true }
            return have.updatedAt <= s.updatedAt
        }
        if fresh.isEmpty && !prev.isEmpty { return }
        subagents[sessionId] = Self.mergeById(prev, fresh, order: { $0.startedAt })
    }

    /// The most output text a client keeps for one task; older lines are dropped past it.
    public static let taskOutputKeepChars = 512 * 1024

    /// Fold a slice into the task's output: a slice that starts where the loaded text ends is
    /// appended; one that's already covered (a repeated poll) only updates `done`; anything else (the
    /// first read, or a gap after a burst) replaces it. Lengths count UTF-16 code units, as in JS.
    public static func mergeTaskOutput(_ prev: TaskOutputState?, _ out: TaskOutput) -> TaskOutputState {
        guard out.available else {
            guard var prev else { return TaskOutputState(text: "", end: out.end, size: 0, done: out.done, available: false, truncated: false) }
            prev.done = out.done
            prev.available = !prev.text.isEmpty
            return prev
        }
        var next: TaskOutputState
        if let prev, prev.available, out.start == prev.end {
            next = prev
            next.text += out.text
            next.end = out.end
            next.size = out.size
            next.done = out.done
        } else if var prev, prev.available, out.start < prev.end, out.end <= prev.end {
            prev.done = out.done
            return prev
        } else {
            next = TaskOutputState(text: out.text, end: out.end, size: out.size, done: out.done, available: true, truncated: out.start > 0)
        }
        let units = next.text.utf16
        if units.count > taskOutputKeepChars {
            let cut = units.count - taskOutputKeepChars
            let from = units.index(units.startIndex, offsetBy: cut)
            // The first line break at or after the cut, if it's near; else cut mid-line.
            let nl = units[from...].firstIndex(of: 0x0A)
            let start = nl.flatMap { units.distance(from: from, to: $0) < 4096 ? units.index(after: $0) : nil } ?? from
            next.text = String(decoding: Array(units[start...]), as: UTF16.self)
            next.truncated = true
        }
        return next
    }

    mutating func mergeActivity(_ sessionId: String, _ incoming: [ActivityEntry]) {
        activity[sessionId] = Self.mergeById(activity[sessionId] ?? [], incoming, order: { $0.createdAt })
    }

    /// Where a revision's body lives in `specBodies`.
    public static func specBodyKey(_ ticketId: String, _ rev: Int) -> String { "\(ticketId)#\(rev)" }

    /// A ticket's revision list with approvedBaseline set on `baseline` only (`.null`: none,
    /// `.absent`: leave the list alone).
    static func withBaseline(_ list: [SpecRevisionInfo], _ baseline: Patch<Int>) -> [SpecRevisionInfo] {
        if case .absent = baseline { return list }
        let b = baseline.optional
        guard list.contains(where: { $0.approvedBaseline != ($0.rev == b) }) else { return list }
        return list.map { r in
            var r = r
            r.approvedBaseline = r.rev == b
            return r
        }
    }

    /// Revisions merged by rev, oldest first.
    static func mergeRevisions(_ prev: [SpecRevisionInfo], _ next: [SpecRevisionInfo]) -> [SpecRevisionInfo] {
        var byRev: [Int: SpecRevisionInfo] = [:]
        for r in prev { byRev[r.rev] = r }
        for r in next { byRev[r.rev] = r }
        return byRev.values.sorted { $0.rev < $1.rev }
    }

    /// Drop a run's streamed text (`runId` nil: every run of the session).
    mutating func clearDelta(_ sessionId: String, _ runId: String?) {
        guard var forSession = deltas[sessionId] else { return }
        guard let runId else {
            deltas[sessionId] = nil
            return
        }
        guard forSession[runId] != nil else { return }
        forSession[runId] = nil
        deltas[sessionId] = forSession.isEmpty ? nil : forSession
    }

    static let terminalRun: [RunStatus] = [.succeeded, .failed, .cancelled]

    /// Drop the deltas a refetch shows are over: those of sessions that aren't busy, and of runs
    /// that ended. A client that missed the events that clear a delta (the app was suspended
    /// mid-stream, the socket dropped) would otherwise show the half-streamed text under the
    /// transcript for good.
    mutating func pruneDeltas(sessions: [String: Session], runs: [Run]) {
        for sessionId in deltas.keys.sorted() where sessions[sessionId]?.busy == false {
            clearDelta(sessionId, nil)
        }
        for r in runs where Self.terminalRun.contains(r.status) {
            clearDelta(r.sessionId, r.id)
        }
    }

    // MARK: Reducer

    /// `applyEvent`: one live event.
    public mutating func apply(_ event: HarnessEvent) {
        switch event {
        case let .projectUpserted(project):
            projects[project.id] = project
        case let .projectDeleted(id):
            projects[id] = nil
            tickets = tickets.filter { $0.value.projectId != id }
        case let .ticketUpserted(ticket):
            donePaging = Paging.adjustDoneTotals(self, prev: tickets[ticket.id], next: ticket)
            tickets[ticket.id] = ticket
            if let list = specRevisions[ticket.id] {
                let marked = Self.withBaseline(list, ticket.specBaselineRevision)
                if marked != list { specRevisions[ticket.id] = marked }
            }
        case let .ticketDeleted(id):
            donePaging = Paging.adjustDoneTotals(self, prev: tickets[id], next: nil)
            tickets[id] = nil
        case let .sessionUpserted(session):
            sessions[session.id] = session
        case let .runUpserted(run):
            if Self.terminalRun.contains(run.status) { clearDelta(run.sessionId, run.id) }
            runs[run.id] = run
        case let .transcriptAppended(entry):
            let subagentId = entry.subagentId.optional
            mergeTranscript(Self.transcriptKey(entry.sessionId, subagentId), [entry], loaded: false)
            // The persisted assistant text block replaces the streamed preview of the same run
            // (sub-agents don't stream, so their text leaves the agent's preview alone).
            if entry.role == .assistant, case .text = entry.content, subagentId?.isEmpty ?? true {
                clearDelta(entry.sessionId, entry.runId)
            }
        case let .transcriptDelta(sessionId, runId, text):
            var forSession = deltas[sessionId] ?? [:]
            forSession[runId, default: ""] += text
            deltas[sessionId] = forSession
        case let .subagentUpserted(subagent):
            mergeSubagents(subagent.sessionId, [subagent])
        case let .activityAdded(entry):
            mergeActivity(entry.sessionId, [entry])
        case let .specRevised(ticketId, rev, author, note, runId, runKind, createdAt):
            // Only a list that was loaded grows: an unknown one is fetched whole when it's shown.
            guard let list = specRevisions[ticketId] else { break }
            let info = SpecRevisionInfo(
                rev: rev, author: author, runId: runId.optional, runKind: runKind.optional, note: note, approvedBaseline: false,
                createdAt: createdAt ?? 0)
            specRevisions[ticketId] = Self.mergeRevisions(list, [info])
        case let .watcherUpserted(watcher):
            watchers[watcher.id] = watcher
        case let .watcherDeleted(id):
            watchers[id] = nil
        case let .settingsUpdated(settings):
            self.settings = settings
        case .browserFrame, .browserState:
            // High-frequency, view-local; the Browser tab consumes these directly.
            break
        case .sessionDeleted, .serviceStatus, .unknown:
            break
        }
    }

    /// `reducer`: apply one action in place.
    public mutating func reduce(_ action: BoardAction) {
        switch action {
        case let .event(event):
            apply(event)
        case let .connected(value):
            connected = value
        case let .snapshot(s):
            // A snapshot is authoritative for entity lists; transcripts/activity are kept (they
            // are merged by id, and views refetch them on reconnect), and so are the deltas of
            // busy sessions. Paging restarts from its
            // first page; an active search is re-armed (ids → null) for the client to re-run.
            let all = s.donePage.map { s.tickets + $0.page.tickets } ?? s.tickets
            var paging: [String: DonePaging] = [:]
            if let dp = s.donePage { paging[dp.scope] = Paging.pagingFromPage(dp.page, prev: nil, append: false) }
            ready = true
            projects = Self.preferNewer(Self.byId(s.projects), projects, updatedAt: { $0.updatedAt })
            tickets = Self.preferNewer(Self.byId(all), tickets, updatedAt: { $0.updatedAt })
            donePaging = paging
            if var search {
                search.ids = nil
                search.nextCursor = nil
                search.total = 0
                search.loading = true
                search.error = nil
                self.search = search
            }
            keyAliases = [:]
            missingKeys = [:]
            childrenLoaded = [:]
            dependents = [:]
            ticketsAsOf = all.reduce(0) { max($0, $1.createdAt) }
            sessions = Self.preferNewer(Self.byId(s.sessions), sessions, updatedAt: { $0.updatedAt })
            pruneDeltas(sessions: sessions, runs: [])
            watchers = Self.byId(s.watchers)
            settings = s.settings
            drivers = s.drivers
        case let .detail(d, requestedKey):
            // The parent rides along so a child's "Part of …" breadcrumb works when the conductor isn't loaded.
            tickets = Paging.mergeTickets(tickets, [d.ticket] + d.children + (d.parent.optional.map { [$0] } ?? []))
            let asked = (d.resolvedFrom ?? requestedKey).map(JSString.upper)
            if let asked, asked != JSString.upper(d.ticket.key) { keyAliases[asked] = d.ticket.id }
            if let asked, missingKeys[asked] == true { missingKeys[asked] = nil }
            if d.ticket.isConductor { childrenLoaded[d.ticket.id] = true }
            dependents[d.ticket.id] = d.dependents
            for r in d.runs { runs[r.id] = r }
            pruneDeltas(sessions: [:], runs: d.runs)
            sessions[d.session.id] = d.session
            // Older services don't send sub-agents: leave the session's list unknown then.
            if let subs = d.subagents { mergeSubagents(d.session.id, subs) }
            mergeActivity(d.session.id, d.activity)
        case let .transcript(sessionId, subagentId, entries):
            mergeTranscript(Self.transcriptKey(sessionId, subagentId.optional), entries, loaded: true)
        case let .subagents(sessionId, list):
            mergeSubagents(sessionId, list)
        case let .taskOutput(sessionId, subagentId, output):
            let key = Self.transcriptKey(sessionId, subagentId)
            let next = Self.mergeTaskOutput(taskOutputs[key], output)
            if next != taskOutputs[key] { taskOutputs[key] = next }
        case let .activity(sessionId, list):
            mergeActivity(sessionId, list)
        case let .specRevisions(ticketId, revisions):
            let baseline = tickets[ticketId]?.specBaselineRevision ?? .absent
            specRevisions[ticketId] = Self.withBaseline(Self.mergeRevisions(specRevisions[ticketId] ?? [], revisions), baseline)
        case let .specRevision(ticketId, r):
            specBodies[Self.specBodyKey(ticketId, r.rev)] = r.body
            if let prev = specRevisions[ticketId] { specRevisions[ticketId] = Self.mergeRevisions(prev, [r.info]) }
        case let .drivers(list):
            drivers = list
        case let .tickets(list):
            tickets = Paging.mergeTickets(tickets, list)
        case let .missingKeys(keys):
            for k in keys { missingKeys[JSString.upper(k)] = true }
        case .donePageRequest, .donePage, .donePageError, .searchSet, .searchRequest, .searchResults, .searchError:
            Paging.reduce(&self, action)
        }
    }

    /// `reducer(state, action)` as a pure function.
    public func reduced(_ action: BoardAction) -> BoardState {
        var next = self
        next.reduce(action)
        return next
    }
}
