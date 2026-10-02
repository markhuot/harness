import Foundation

// The decisions behind the Inbox, the triage screen, the Agents & tasks tab, the sub-agent view and
// the task output view, pulled
// out of the views so they can be tested.

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

    /// Where its file links open (FileViewer.triageLinkContext for its dispatched ticket).
    public static func linkContext(_ state: BoardState, _ s: Session) -> FileLinkContext {
        let key = Format.dispatchedKey(s)
        return FileViewer.triageLinkContext(dispatchedKey: key, dispatchedProjectId: key.flatMap { state.ticketByKey($0) }?.projectId)
    }
}

public enum AgentsLogic {
    /// The Agents & tasks list: one list of sub-agents and tasks, the latest updated first.
    public static func list(_ list: [Subagent]) -> [Subagent] {
        Subagents.sort(list)
    }

    /// A row's second line: the result once it's finished with one, else the task it was given (a
    /// background task's command, unless that's already its title).
    public static func preview(_ a: Subagent) -> String {
        if a.status != .running, let r = a.result, !r.isEmpty { return r }
        if Subagents.isTask(a) {
            let cmd = a.command.optional.map(JSCompat.trim) ?? ""
            return cmd == Subagents.title(a) ? "" : cmd
        }
        return a.prompt
    }

    /// The row's accessibility label: "Find the auth middleware, Running".
    public static func rowLabel(_ a: Subagent) -> String {
        "\(Subagents.title(a)), \(Subagents.statusLabel(a.status))"
    }

    /// How often the durations tick: every second while something runs, else every minute.
    public static func tickSeconds(running: Bool) -> Double { running ? 1 : 60 }

    // MARK: Task output

    /// Above the output when earlier lines aren't shown.
    public static let truncatedNote = "Showing the latest output only"

    /// What the output pane says in place of output: nil while the first read is in flight and
    /// once there's text to show. `running` is the task's status (the service's `done` wins).
    public static func outputNote(_ o: TaskOutputState?, running: Bool) -> String? {
        guard let o else { return nil }
        if !o.available { return "Output isn't available" }
        guard o.text.isEmpty else { return nil }
        return running && !o.done ? "Waiting for output…" : "No output"
    }

    /// The next poll's `offset`: where the loaded text ends, or nil (the tail) before any is loaded.
    public static func pollOffset(_ o: TaskOutputState?) -> Int? {
        guard let o, o.available else { return nil }
        return o.end
    }

    /// Whether to poll again after a read: while the task runs and its output can still grow.
    public static func keepsPolling(_ status: SubagentStatus?, _ o: TaskOutputState?) -> Bool {
        status == .running && o?.done != true
    }

    /// The status mark's tone and icon for a finished sub-agent or task (running shows a spinner).
    public static func mark(_ status: SubagentStatus) -> (tone: Format.Tone, icon: String) {
        switch status {
        case .succeeded: (.green, "check")
        case .failed: (.red, "x")
        default: (.neutral, "stop")
        }
    }
}
