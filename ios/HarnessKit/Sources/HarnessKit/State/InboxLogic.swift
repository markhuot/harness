import Foundation

// The decisions behind the Agents & tasks tab, the sub-agent view and the task output view, pulled
// out of the views so they can be tested.

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

    /// In place of the list when the filter keeps one kind and the session has none of it.
    public static func emptyNote(_ filter: Subagents.Filter) -> String {
        filter.agents ? "No sub-agents yet" : "No background tasks yet"
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
