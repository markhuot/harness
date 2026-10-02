import Foundation

public struct Session: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    /// Display key: the ticket key, or TRIAGE-n for ephemeral triage sessions
    public var key: String
    public var kind: SessionKind
    @Nullable public var ticketId: String?
    public var driver: String
    public var cwd: String
    /// Title for triage sessions (the external item summary)
    public var title: String
    /// Triage lifecycle; ticket sessions mirror their ticket instead
    @Nullable public var triageStatus: TriageStatus?
    /// Outcome text for triage sessions (dispatched to X / declined because Y)
    @Nullable public var outcome: String?
    public var busy: Bool
    public var createdAt: Timestamp
    public var updatedAt: Timestamp

    public init(
        id: String, key: String, kind: SessionKind, ticketId: String? = nil, driver: String, cwd: String,
        title: String = "", triageStatus: TriageStatus? = nil, outcome: String? = nil, busy: Bool = false,
        createdAt: Timestamp, updatedAt: Timestamp
    ) {
        self.id = id
        self.key = key
        self.kind = kind
        self.ticketId = ticketId
        self.driver = driver
        self.cwd = cwd
        self.title = title
        self.triageStatus = triageStatus
        self.outcome = outcome
        self.busy = busy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct Run: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var sessionId: String
    public var kind: RunKind
    public var status: RunStatus
    public var driver: String
    public var prompt: String
    @Nullable public var error: String?
    public var createdAt: Timestamp
    @Nullable public var startedAt: Timestamp?
    @Nullable public var endedAt: Timestamp?

    public init(
        id: String, sessionId: String, kind: RunKind, status: RunStatus, driver: String, prompt: String,
        error: String? = nil, createdAt: Timestamp, startedAt: Timestamp? = nil, endedAt: Timestamp? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.kind = kind
        self.status = status
        self.driver = driver
        self.prompt = prompt
        self.error = error
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.endedAt = endedAt
    }
}

/// One block of a transcript entry, discriminated by `type`. An unknown `type` decodes to
/// `.unknown(type:raw:)` and re-encodes `raw` unchanged.
public enum TranscriptContent: Codable, Sendable, Equatable {
    case text(text: String)
    case thinking(text: String)
    case toolCall(callId: String, name: String, input: JSONValue)
    case toolResult(callId: String, name: String, output: [ToolResultContent], isError: Bool)
    /// e.g. "Moved to review", "Run started (work)"; `permission` marks a permission decision
    /// (auto-approved, sent to a human, denied)
    case status(text: String, permission: PermissionDecisionLog? = nil)
    case error(text: String)
    case unknown(type: String, raw: JSONValue)

    /// The wire discriminator.
    public var type: String {
        switch self {
        case .text: "text"
        case .thinking: "thinking"
        case .toolCall: "tool_call"
        case .toolResult: "tool_result"
        case .status: "status"
        case .error: "error"
        case let .unknown(type, _): type
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let type = try c.decode(String.self, forKey: "type")
        switch type {
        case "text": self = .text(text: try c.decode(String.self, forKey: "text"))
        case "thinking": self = .thinking(text: try c.decode(String.self, forKey: "text"))
        case "tool_call":
            self = .toolCall(
                callId: try c.decode(String.self, forKey: "callId"),
                name: try c.decode(String.self, forKey: "name"),
                input: try c.decodeIfPresent(JSONValue.self, forKey: "input") ?? .null
            )
        case "tool_result":
            self = .toolResult(
                callId: try c.decode(String.self, forKey: "callId"),
                name: try c.decode(String.self, forKey: "name"),
                output: try c.decode([ToolResultContent].self, forKey: "output"),
                isError: try c.decode(Bool.self, forKey: "isError")
            )
        case "status":
            self = .status(
                text: try c.decode(String.self, forKey: "text"),
                permission: try c.decodeIfPresent(PermissionDecisionLog.self, forKey: "permission")
            )
        case "error": self = .error(text: try c.decode(String.self, forKey: "text"))
        default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(type, forKey: "type")
        switch self {
        case let .text(text), let .thinking(text), let .error(text):
            try c.encode(text, forKey: "text")
        case let .toolCall(callId, name, input):
            try c.encode(callId, forKey: "callId")
            try c.encode(name, forKey: "name")
            try c.encode(input, forKey: "input")
        case let .toolResult(callId, name, output, isError):
            try c.encode(callId, forKey: "callId")
            try c.encode(name, forKey: "name")
            try c.encode(output, forKey: "output")
            try c.encode(isError, forKey: "isError")
        case let .status(text, permission):
            try c.encode(text, forKey: "text")
            try c.encodeIfPresent(permission, forKey: "permission")
        case .unknown: break
        }
    }
}

/// What a tool call returned. An unknown `type` decodes to `.unknown(type:raw:)`.
public enum ToolResultContent: Codable, Sendable, Equatable {
    case text(text: String)
    /// `data` is base64
    case image(data: String, mimeType: String)
    case unknown(type: String, raw: JSONValue)

    public var type: String {
        switch self {
        case .text: "text"
        case .image: "image"
        case let .unknown(type, _): type
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let type = try c.decode(String.self, forKey: "type")
        switch type {
        case "text": self = .text(text: try c.decode(String.self, forKey: "text"))
        case "image":
            self = .image(data: try c.decode(String.self, forKey: "data"), mimeType: try c.decode(String.self, forKey: "mimeType"))
        default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(type, forKey: "type")
        switch self {
        case let .text(text): try c.encode(text, forKey: "text")
        case let .image(data, mimeType):
            try c.encode(data, forKey: "data")
            try c.encode(mimeType, forKey: "mimeType")
        case .unknown: break
        }
    }
}

public struct TranscriptEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var sessionId: String
    @Nullable public var runId: String?
    /// The sub-agent that produced this entry (Subagent.id), or null for the session's own agent.
    /// GET /sessions/:id/transcript leaves sub-agent entries out unless `?subagent=<id>` asks for
    /// them. Optional so clients tolerate an older service without sub-agents.
    public var subagentId: Patch<String>
    public var seq: Int
    public var role: TranscriptRole
    public var content: TranscriptContent
    public var createdAt: Timestamp

    public init(
        id: String, sessionId: String, runId: String? = nil, subagentId: Patch<String> = .absent, seq: Int,
        role: TranscriptRole, content: TranscriptContent, createdAt: Timestamp
    ) {
        self.id = id
        self.sessionId = sessionId
        self.runId = runId
        self.subagentId = subagentId
        self.seq = seq
        self.role = role
        self.content = content
        self.createdAt = createdAt
    }
}

/// A sub-agent an agent started inside its own session (Claude Code's Agent / Task tool), not a
/// ticket. Drivers report them with the "subagent" driver event; its conversation is the session's
/// transcript entries carrying its id as `subagentId` (DESIGN.md "Sub-agents").
///
/// A background task (a Bash command or Monitor the agent left running, `kind` bash or monitor) is
/// reported the same way. It has no conversation: its output is read with
/// GET /sessions/:id/subagents/:subagentId/output (TaskOutput).
public struct Subagent: Codable, Sendable, Equatable, Identifiable {
    /// The id of the tool call that started it (unique within the session)
    public var id: String
    public var sessionId: String
    /// The run it was started in
    @Nullable public var runId: String?
    /// The sub-agent that started this one (nested agents), else null
    @Nullable public var parentId: String?
    /// Short description of its task, e.g. "Find the auth middleware"
    public var description: String
    /// The kind of agent, e.g. "general-purpose", "Explore" (null when the driver doesn't say)
    @Nullable public var agentType: String?
    /// The instructions it was given
    public var prompt: String
    public var status: SubagentStatus
    /// Its final report when it finished (or why it failed)
    @Nullable public var result: String?
    public var startedAt: Timestamp
    @Nullable public var endedAt: Timestamp?
    public var updatedAt: Timestamp
    /// "agent" (absent from older services), or the kind of background task
    public var kind: SubagentKind?
    /// A background task's command (null for agents)
    public var command: Patch<String>
    /// A background task has output to read (GET …/output)
    public var hasOutput: Bool?

    public init(
        id: String, sessionId: String, runId: String? = nil, parentId: String? = nil, description: String,
        agentType: String? = nil, prompt: String, status: SubagentStatus, result: String? = nil,
        startedAt: Timestamp, endedAt: Timestamp? = nil, updatedAt: Timestamp,
        kind: SubagentKind? = nil, command: Patch<String> = .absent, hasOutput: Bool? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.runId = runId
        self.parentId = parentId
        self.description = description
        self.agentType = agentType
        self.prompt = prompt
        self.status = status
        self.result = result
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.updatedAt = updatedAt
        self.kind = kind
        self.command = command
        self.hasOutput = hasOutput
    }
}

/// A slice of a background task's output (GET /sessions/:id/subagents/:subagentId/output). Offsets
/// count bytes of the output. Without `offset` the route sends the tail (up to 256 KB); with one, the
/// output after it, skipping ahead to the tail when more than that came in since (`start` > the
/// offset asked for: a gap). Text is UTF-8 with terminal escapes removed.
public struct TaskOutput: Codable, Sendable, Equatable {
    public var text: String
    /// Where `text` starts in the output
    public var start: Int
    /// Where it ends: pass it back as `offset` to read on
    public var end: Int
    /// The output's size so far
    public var size: Int
    /// The task finished: the output won't grow
    public var done: Bool
    /// false when there's no output to read (the file is gone, or the driver never said where it is)
    public var available: Bool

    public init(text: String, start: Int, end: Int, size: Int, done: Bool, available: Bool) {
        self.text = text
        self.start = start
        self.end = end
        self.size = size
        self.done = done
        self.available = available
    }
}
