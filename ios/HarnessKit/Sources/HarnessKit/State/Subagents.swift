import Foundation

// Port of shared/src/state/subagents.ts: sub-agents an agent started inside its session
// (DESIGN.md "Sub-agents"), selectors and labels for the ticket's Agents tab and the sub-agent
// transcript view.

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

    /// What a sub-agent row is called: its task description, else its agent type.
    public static func title(description: String, agentType: String?) -> String {
        let d = JSCompat.trim(description)
        if !d.isEmpty { return d }
        if let agentType, !agentType.isEmpty { return agentType }
        return "Sub-agent"
    }

    public static func title(_ s: Subagent) -> String { title(description: s.description, agentType: s.agentType) }

    /// "Explore" · "general-purpose" chip text; nil when it would just repeat the title.
    public static func typeLabel(description: String, agentType: String?) -> String? {
        guard let agentType, !agentType.isEmpty, !JSCompat.trim(description).isEmpty else { return nil }
        return agentType
    }

    public static func typeLabel(_ s: Subagent) -> String? { typeLabel(description: s.description, agentType: s.agentType) }

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

    public struct Groups: Codable, Sendable, Equatable {
        public var running: [Subagent]
        public var finished: [Subagent]
    }

    /// Running sub-agents first (oldest first), then finished ones, newest first.
    public static func group(_ list: [Subagent]) -> Groups {
        let running = list.filter { $0.status == .running }
        // Stable, like Array.prototype.sort: equal end times keep the list's order.
        let finished = list.filter { $0.status != .running }.sorted { ($0.endedAt ?? $0.startedAt) > ($1.endedAt ?? $1.startedAt) }
        return Groups(running: running, finished: finished)
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
