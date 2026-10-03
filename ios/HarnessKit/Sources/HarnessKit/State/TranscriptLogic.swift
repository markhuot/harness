import Foundation

// The decisions behind the native TranscriptView: which rows the list shows (grouped entries, the
// streaming delta, "Working…"), which sub-agent a tool row started, and how a tool call's input is
// printed.

public enum TranscriptLogic {
    /// One row of the transcript list.
    public enum Row: Sendable, Equatable, Identifiable {
        case item(Format.TranscriptItem)
        /// The current run's streaming text (not for sub-agents, whose blocks arrive whole)
        case delta(runId: String, text: String)
        /// The agent is busy and hasn't streamed anything yet
        case working

        /// Stable across renders: the entry's id, `delta-<run>`, `working`.
        public var id: String {
            switch self {
            case let .item(i): i.id
            case let .delta(runId, _): "delta-\(runId)"
            case .working: "working"
            }
        }
    }

    /// The grouped entries, then the live deltas, then "Working…" while busy with no delta. Entries
    /// that draw nothing (a bare tool_call, content this build doesn't know) are left out, so the
    /// list doesn't space around empty rows.
    public static func rows(items: [Format.TranscriptItem], deltas: [LiveDelta], working: Bool) -> [Row] {
        var rows = items.filter(draws).map(Row.item)
        rows.append(contentsOf: deltas.map { .delta(runId: $0.runId, text: $0.text) })
        if working, deltas.isEmpty { rows.append(.working) }
        return rows
    }

    /// How many of the newest rows the list draws at first, and how many more each "Show earlier
    /// messages" adds. The native list is a plain stack: a lazy one re-estimates the rows it hasn't
    /// measured as they scroll by, so its height jumps and the bottom can't be held. A window keeps
    /// heights exact while a transcript of thousands of entries stays cheap to draw.
    public static let windowStep = 150

    /// The newest `limit` rows, and how many older ones are left out.
    public static func window(_ rows: [Row], limit: Int) -> (rows: ArraySlice<Row>, hidden: Int) {
        let hidden = max(0, rows.count - max(limit, 0))
        return (rows[hidden...], hidden)
    }

    static func draws(_ item: Format.TranscriptItem) -> Bool {
        guard case let .entry(e) = item else { return true }
        switch e.content {
        case .toolCall, .unknown: return false
        default: return true
        }
    }

    /// The deltas a transcript streams: none for a sub-agent.
    public static func deltas(_ state: BoardState, sessionId: String, subagentId: String?) -> [LiveDelta] {
        subagentId == nil ? state.liveDelta(sessionId) : []
    }

    /// Whether the transcript's agent is at work: the sub-agent while it runs, else the session's busy flag.
    public static func working(_ state: BoardState, sessionId: String, subagentId: String?) -> Bool {
        if let subagentId { return state.subagentById(sessionId, subagentId)?.status == .running }
        return state.sessions[sessionId]?.busy ?? false
    }

    /// "Agent" for the session's own agent, "Sub-agent" inside one.
    public static func who(subagentId: String?) -> String { subagentId == nil ? "Agent" : "Sub-agent" }

    /// The sub-agent a tool call started (its id is the call's callId), when the call started one.
    public static func agent(for call: TranscriptEntry, in subagents: [Subagent]?) -> Subagent? {
        guard case let .toolCall(callId, _, _) = call.content else { return nil }
        return subagents?.first { $0.id == callId }
    }

    /// The name a tool row shows: the call's, else the result's, shortened.
    public static func toolName(call: TranscriptEntry?, result: TranscriptEntry?) -> String {
        if case let .toolCall(_, name, _)? = call?.content { return Format.shortToolName(name) }
        if case let .toolResult(_, name, _, _)? = result?.content { return Format.shortToolName(name) }
        return Format.shortToolName("tool")
    }

    /// `JSON.stringify(input, null, 2)` for the expanded tool row's Input.
    public static func inputJSON(_ input: JSONValue) -> String {
        JSJSON.stringify(input, indent: 2)
    }

    /// The tool output cap the expanded row shows (`formatMaybeJson(o.text, 12000)`, from
    /// shared/src/state/format.ts).
    public static let outputLimit = 12000

    /// Lines per Text in a tool row's code box, and the longest line it shows unbroken. A Text past
    /// the size iOS draws in one layer shows blank: a capped output can run to hundreds of lines, or
    /// hold one line thousands of characters long (a spec as a JSON string).
    public static let codeChunkLines = 80
    public static let codeLineLimit = 500

    /// `text` cut into runs of at most `lines` lines, each without its last newline, after breaking
    /// any line longer than `width` characters into pieces of `width`. Joined with "\n" they give
    /// `text` back when no line was broken. Empty text is one empty chunk.
    public static func codeChunks(_ text: String, lines: Int = codeChunkLines, width: Int = codeLineLimit) -> [String] {
        let width = max(width, 1), lines = max(lines, 1)
        var all: [Substring] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var rest = line
            while rest.count > width {
                all.append(rest.prefix(width))
                rest = rest.dropFirst(width)
            }
            all.append(rest)
        }
        return stride(from: 0, to: all.count, by: lines).map {
            all[$0..<min($0 + lines, all.count)].joined(separator: "\n")
        }
    }

    /// The tool row's trailing mark: running until the result arrives, then ✓ or ✗.
    public enum ToolState: Sendable, Equatable { case running, ok, failed }

    public static func toolState(result: TranscriptEntry?) -> ToolState {
        guard case let .toolResult(_, _, _, isError)? = result?.content else { return .running }
        return isError ? .failed : .ok
    }

    /// "Allow"/"Ask"/"Deny"'s edge color on a permission row.
    public enum DecisionTone: Sendable, Equatable { case green, amber, red }

    public static func decisionTone(_ d: PermissionDecision) -> DecisionTone {
        switch d {
        case .allow: .green
        case .ask: .amber
        default: .red
        }
    }

    /// The permission row's footer: "classifier · auto mode · 3:04 PM".
    public static func permissionFooter(_ log: PermissionDecisionLog, time: String?) -> String {
        "\(Format.decisionSource(log)) · \(log.mode.rawValue) mode" + (time.map { " · \($0)" } ?? "")
    }
}
