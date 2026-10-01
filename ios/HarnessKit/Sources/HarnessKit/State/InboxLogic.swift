import Foundation

// The decisions screens/Inbox.tsx and screens/AgentsTab.tsx make inline, for the native Inbox,
// triage screen, Agents tab and sub-agent view.

public enum InboxLogic {
    /// The watcher strip's order: enabled ones first, then by name (`localeCompare`).
    public static func sortedWatchers(_ watchers: [Watcher]) -> [Watcher] {
        watchers.sorted { a, b in
            if a.enabled != b.enabled { return a.enabled }
            let c = BoardState.localeCompare(a.name, b.name)
            return c != .orderedSame ? c == .orderedAscending : JSString.less(a.id, b.id)
        }
    }

    /// "Loop" or "Every 60s".
    public static func scheduleLabel(_ w: Watcher) -> String {
        w.mode == .loop ? "Loop" : "Every \(w.intervalSec)s"
    }

    /// "Retry now" shows for a failed watcher whose process isn't running right now.
    public static func showsRetry(_ w: Watcher, status: WatcherStatus) -> Bool {
        status.error != nil && w.live?.state != .running
    }

    /// The triage badge of a session (no status yet reads as triaging).
    public static func triageLabel(_ s: Session) -> Format.TriageLabel {
        let status = s.triageStatus ?? .triaging
        return Format.triageLabel[status] ?? Format.TriageLabel(label: status.rawValue, tone: .neutral)
    }

    /// The outcome callout's tone and icon: dispatched is green, failed red, anything else neutral.
    public static func outcomeStyle(_ s: Session) -> (tone: Format.Tone, icon: String) {
        switch s.triageStatus {
        case .dispatched?: (.green, "checkCircle")
        case .failed?: (.red, "alert")
        default: (.neutral, "alert")
        }
    }

    /// The ticket a triage session dispatched, when it's loaded.
    public static func dispatchedTicket(_ state: BoardState, _ s: Session) -> Ticket? {
        Format.dispatchedKey(s).flatMap { state.ticketByKey($0) }
    }

    /// Where its file links open (RN `triageLinkContext(key, dispatched)`).
    public static func linkContext(_ state: BoardState, _ s: Session) -> FileLinkContext {
        let key = Format.dispatchedKey(s)
        return FileViewer.triageLinkContext(dispatchedKey: key, dispatchedProjectId: key.flatMap { state.ticketByKey($0) }?.projectId)
    }
}

public enum AgentsLogic {
    public struct Section: Sendable, Equatable, Identifiable {
        public var id: String
        public var label: String
        public var items: [Subagent]
    }

    /// "Running" then "Finished", each only when it has sub-agents.
    public static func sections(_ list: [Subagent]) -> [Section] {
        let g = Subagents.group(list)
        return [Section(id: "running", label: "Running", items: g.running), Section(id: "finished", label: "Finished", items: g.finished)]
            .filter { !$0.items.isEmpty }
    }

    /// A row's second line: the result once it's finished with one, else the task it was given.
    public static func preview(_ a: Subagent) -> String {
        if a.status != .running, let r = a.result, !r.isEmpty { return r }
        return a.prompt
    }

    /// The row's accessibility label: "Find the auth middleware, Running".
    public static func rowLabel(_ a: Subagent) -> String {
        "\(Subagents.title(a)), \(Subagents.statusLabel(a.status))"
    }

    /// How often the durations tick: every second while something runs, else every minute.
    public static func tickSeconds(running: Bool) -> Double { running ? 1 : 60 }

    /// The status mark's tone and icon for a finished sub-agent (running shows a spinner).
    public static func mark(_ status: SubagentStatus) -> (tone: Format.Tone, icon: String) {
        switch status {
        case .succeeded: (.green, "check")
        case .failed: (.red, "x")
        default: (.neutral, "stop")
        }
    }
}
