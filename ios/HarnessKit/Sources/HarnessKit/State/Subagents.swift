import Foundation

// Port of shared/src/state/subagents.ts: sub-agents an agent started inside its session, and the
// background tasks it left running (DESIGN.md "Sub-agents", "Background tasks"): selectors and
// labels for the ticket's Agents & tasks tab, the sub-agent transcript view and the task output view.

public enum Subagents {
    public static let statusLabel: [SubagentStatus: String] = [
        .running: "Running",
        .succeeded: "Done",
        .failed: "Failed",
        .stopped: "Stopped",
    ]

    /// The label for a status (the raw value for one this build doesn't know).
    public static func statusLabel(_ status: SubagentStatus) -> String {
        statusLabel[status] ?? status.rawValue
    }

    public static let taskKindLabel: [SubagentKind: String] = [
        .bash: "Bash",
        .monitor: "Monitor",
    ]

    /// A background task (a Bash command, a Monitor), not an agent.
    public static func isTask(_ kind: SubagentKind?) -> Bool {
        kind == .bash || kind == .monitor
    }

    public static func isTask(_ s: Subagent) -> Bool { isTask(s.kind) }

    /// What a row is called: its task description, else its command (a task) or agent type.
    public static func title(description: String, agentType: String?, kind: SubagentKind? = nil, command: String? = nil) -> String {
        let d = JSCompat.trim(description)
        if !d.isEmpty { return d }
        if isTask(kind) {
            let cmd = command.map(JSCompat.trim) ?? ""
            return cmd.isEmpty ? "Background task" : cmd
        }
        if let agentType, !agentType.isEmpty { return agentType }
        return "Sub-agent"
    }

    public static func title(_ s: Subagent) -> String {
        title(description: s.description, agentType: s.agentType, kind: s.kind, command: s.command.optional)
    }

    /// "Explore" · "general-purpose" · "Bash" chip text; nil when it would just repeat the title.
    public static func typeLabel(description: String, agentType: String?, kind: SubagentKind? = nil) -> String? {
        if let kind, isTask(kind) { return taskKindLabel[kind] }
        guard let agentType, !agentType.isEmpty, !JSCompat.trim(description).isEmpty else { return nil }
        return agentType
    }

    public static func typeLabel(_ s: Subagent) -> String? { typeLabel(description: s.description, agentType: s.agentType, kind: s.kind) }

    /// A sub-agent's model as a chip: "claude-haiku-4-5-20251001" → "Haiku 4.5", the older
    /// "claude-3-5-sonnet-20241022" → "Sonnet 3.5", an alias "haiku" → "Haiku", a "[1m]" context
    /// suffix → "… 1M". Any other id shows as is; nil while unknown.
    public static func modelLabel(_ model: String?) -> String? {
        let id = JSCompat.trim(model ?? "")
        if id.isEmpty { return nil }
        let isLong = id.lowercased().hasSuffix("[1m]")
        let long = isLong ? " 1M" : ""
        let base = isLong ? String(id.dropLast(4)) : id
        func cap(_ w: Substring) -> String { w.prefix(1).uppercased() + w.dropFirst() }
        func version(_ major: Substring, _ minor: Substring?) -> String { minor.map { "\(major).\($0)" } ?? String(major) }
        if let m = base.wholeMatch(of: /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/) {
            return "\(cap(m.1)) \(version(m.2, m.3))\(long)"
        }
        if let m = base.wholeMatch(of: /claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?/) {
            return "\(cap(m.3)) \(version(m.1, m.2))\(long)"
        }
        if base.wholeMatch(of: /[a-z]+/) != nil { return "\(cap(base[...]))\(long)" }
        return id
    }

    public static func modelLabel(_ s: Subagent) -> String? { modelLabel(s.model.optional) }

    /// The transcript link on the tool row that started it.
    public static func openLabel(_ kind: SubagentKind?) -> String {
        isTask(kind) ? "Open output" : "Open transcript"
    }

    public static func openLabel(_ s: Subagent) -> String { openLabel(s.kind) }

    /// How often a client polls a running task's output while its view is open (ms).
    public static let taskOutputPollMs: Double = 1000

    /// 42s, 3m 5s, 1h 2m: how long it ran (so far, while running).
    public static func duration(startedAt: Timestamp, endedAt: Timestamp?, now: Timestamp = Date().timeIntervalSince1970 * 1000) -> String {
        let total = Int(max(0, JSCompat.round(((endedAt ?? now) - startedAt) / 1000)))
        if total < 60 { return "\(total)s" }
        let m = total / 60
        if m < 60 { return "\(m)m \(total % 60)s" }
        return "\(m / 60)h \(m % 60)m"
    }

    public static func duration(_ s: Subagent, now: Timestamp = Date().timeIntervalSince1970 * 1000) -> String {
        duration(startedAt: s.startedAt, endedAt: s.endedAt, now: now)
    }

    /// The Agents & tasks list: sub-agents and tasks together, the latest updated first, ties to the
    /// later start. Stable, like Array.prototype.sort: full ties keep the list's order.
    public static func sort(_ list: [Subagent]) -> [Subagent] {
        list.enumerated().sorted { a, b in
            if a.element.updatedAt != b.element.updatedAt { return a.element.updatedAt > b.element.updatedAt }
            if a.element.startedAt != b.element.startedAt { return a.element.startedAt > b.element.startedAt }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// The Agents & tasks filter's two toggles. Both on, or both off, shows everything.
    public struct Filter: Codable, Equatable, Hashable, Sendable {
        public var agents: Bool
        public var tasks: Bool

        public init(agents: Bool = false, tasks: Bool = false) {
            self.agents = agents
            self.tasks = tasks
        }
    }

    /// The rows the filter shows: only agents, only tasks, or (both or neither toggled) all of them.
    public static func filter(_ list: [Subagent], _ filter: Filter) -> [Subagent] {
        if filter.agents == filter.tasks { return list }
        return list.filter { isTask($0) == filter.tasks }
    }

    public struct Counts: Codable, Equatable, Sendable {
        public let agents: Int
        public let tasks: Int
    }

    /// How many of each kind, for the filter's toggles.
    public static func counts(_ list: [Subagent]) -> Counts {
        let tasks = list.count { isTask($0) }
        return Counts(agents: list.count - tasks, tasks: tasks)
    }
}

extension BoardState {
    /// The session's sub-agents, oldest first; nil while unknown (no ticket detail yet, or an older service).
    public func subagentsOf(_ sessionId: String) -> [Subagent]? {
        subagents[sessionId]
    }

    public func subagentById(_ sessionId: String, _ id: String) -> Subagent? {
        subagents[sessionId]?.first { $0.id == id }
    }

    /// A sub-agent's transcript as loaded so far (nil before its backfill or first entry).
    public func subagentTranscript(_ sessionId: String, _ id: String) -> TranscriptState? {
        transcripts[Self.transcriptKey(sessionId, id)]
    }

    /// A background task's output as loaded so far (nil before the first read).
    public func taskOutputOf(_ sessionId: String, _ id: String) -> TaskOutputState? {
        taskOutputs[Self.transcriptKey(sessionId, id)]
    }

    /// The chain of sub-agents from the top down to `id` (for a nested agent's breadcrumb).
    public func subagentPath(_ sessionId: String, _ id: String) -> [Subagent] {
        var path: [Subagent] = []
        var seen: Set<String> = []
        var cur = subagentById(sessionId, id)
        while let c = cur, !seen.contains(c.id) {
            seen.insert(c.id)
            path.insert(c, at: 0)
            cur = c.parentId.flatMap { subagentById(sessionId, $0) }
        }
        return path
    }
}
