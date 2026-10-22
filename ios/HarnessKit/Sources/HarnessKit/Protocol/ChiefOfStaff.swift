import Foundation

// Chief of staff (CoS) shapes: the Swift port of shared/src/cos.ts (DESIGN.md "Chief of staff").
// The conventions of HarnessProtocol.swift apply.

public enum CosEventSource: OpenEnum {
    case activity, watcher, schedule
    case unknown(String)
    public static let allKnown: [Self] = [.activity, .watcher, .schedule]
    public var rawValue: String {
        switch self {
        case .activity: "activity"
        case .watcher: "watcher"
        case .schedule: "schedule"
        case let .unknown(r): r
        }
    }
}

/// Where an event is: pending (waiting for triage), triaging, escalated (for the next wake),
/// handling (in a run), handled, or ignored.
public enum CosEventStatus: OpenEnum {
    case pending, triaging, escalated, handling, handled, ignored
    case unknown(String)
    public static let allKnown: [Self] = [.pending, .triaging, .escalated, .handling, .handled, .ignored]
    public var rawValue: String {
        switch self {
        case .pending: "pending"
        case .triaging: "triaging"
        case .escalated: "escalated"
        case .handling: "handling"
        case .handled: "handled"
        case .ignored: "ignored"
        case let .unknown(r): r
        }
    }
}

/// What triage said: not yet, ignore, escalate, or dropped by a coded rule (a chief's own activity,
/// a net-zero move).
public enum CosEventVerdict: OpenEnum {
    case pending, ignore, escalate, filtered
    case unknown(String)
    public static let allKnown: [Self] = [.pending, .ignore, .escalate, .filtered]
    public var rawValue: String {
        switch self {
        case .pending: "pending"
        case .ignore: "ignore"
        case .escalate: "escalate"
        case .filtered: "filtered"
        case let .unknown(r): r
        }
    }
}

/// What the chief did about an event it was woken for.
public enum CosOutcomeKind: OpenEnum {
    case acted, noAction, needsUser
    case unknown(String)
    public static let allKnown: [Self] = [.acted, .noAction, .needsUser]
    public var rawValue: String {
        switch self {
        case .acted: "acted"
        case .noAction: "no_action"
        case .needsUser: "needs_user"
        case let .unknown(r): r
        }
    }
}

/// The chief's own account of one event (CosEvent.outcome).
public struct CosOutcome: Codable, Sendable, Equatable {
    public var kind: CosOutcomeKind
    public var text: String

    public init(kind: CosOutcomeKind, text: String) {
        self.kind = kind
        self.text = text
    }
}

/// A chief of staff (GET /cos). `ticketId` and `key` identify its ticket (kind "cos").
public struct Cos: Codable, Sendable, Equatable, Identifiable {
    public var ticketId: String
    public var key: String
    /// "all" or "group:<group id>"
    public var scope: String
    /// The group it covers; nil for the All chief
    @Nullable public var groupId: String?
    public var enabled: Bool
    public var createdAt: Timestamp
    /// Why the triage in front of it can't run (its events escalate instead); nil when it can
    public var triageUnavailable: Patch<String>

    public var id: String { ticketId }

    public init(ticketId: String, key: String, scope: String, groupId: String? = nil, enabled: Bool = true, createdAt: Timestamp, triageUnavailable: Patch<String> = .absent) {
        self.ticketId = ticketId
        self.key = key
        self.scope = scope
        self.groupId = groupId
        self.enabled = enabled
        self.createdAt = createdAt
        self.triageUnavailable = triageUnavailable
    }
}

/// One row of a chief's Inbox (GET /cos/:id/events).
public struct CosEvent: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    /// The chief that owns it; nil while no chief qualifies (unassigned)
    @Nullable public var cosId: String?
    @Nullable public var projectKey: String?
    public var sourceKind: CosEventSource
    public var title: String
    public var summary: String
    /// "human", "agent", "system", "watcher:<name>" or "cos:<chief id>"
    public var actor: String
    public var status: CosEventStatus
    public var verdict: CosEventVerdict
    @Nullable public var reason: String?
    @Nullable public var model: String?
    @Nullable public var ticketKey: String?
    @Nullable public var wakeId: String?
    /// The run that handled it
    @Nullable public var handledBy: String?
    /// What the chief recorded for it; nil when its run recorded none (and for events handled before outcomes existed)
    @Nullable public var outcome: CosOutcome?
    public var createdAt: Timestamp

    public init(
        id: String, cosId: String? = nil, projectKey: String? = nil, sourceKind: CosEventSource = .activity, title: String, summary: String = "",
        actor: String = "agent", status: CosEventStatus = .pending, verdict: CosEventVerdict = .pending, reason: String? = nil, model: String? = nil,
        ticketKey: String? = nil, wakeId: String? = nil, handledBy: String? = nil, outcome: CosOutcome? = nil, createdAt: Timestamp
    ) {
        self.id = id
        self.cosId = cosId
        self.projectKey = projectKey
        self.sourceKind = sourceKind
        self.title = title
        self.summary = summary
        self.actor = actor
        self.status = status
        self.verdict = verdict
        self.reason = reason
        self.model = model
        self.ticketKey = ticketKey
        self.wakeId = wakeId
        self.handledBy = handledBy
        self.outcome = outcome
        self.createdAt = createdAt
    }
}

/// GET /cos/:id/events
public struct CosEventPage: Codable, Sendable, Equatable {
    public var items: [CosEvent]
    @Nullable public var nextCursor: String?

    public init(items: [CosEvent], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

/// GET /cos/events/badge
public struct CosBadge: Codable, Sendable, Equatable {
    public var total: Int
    public var byCos: [String: Int]

    public init(total: Int, byCos: [String: Int]) {
        self.total = total
        self.byCos = byCos
    }
}

/// One entry of a chief's chat (GET /cos/:id/transcript), discriminated by `kind`. An unknown
/// `kind` decodes to `.unknown` and re-encodes unchanged.
public enum CosChatEntry: Codable, Sendable, Equatable, Identifiable {
    case message(id: String, cosId: String, createdAt: Timestamp, role: String, text: String)
    case ticketCreated(id: String, cosId: String, createdAt: Timestamp, key: String, title: String, status: String)
    case ticketMoved(id: String, cosId: String, createdAt: Timestamp, key: String, title: String, from: String, to: String)
    case eventBatch(id: String, cosId: String, createdAt: Timestamp, wakeId: String, eventIds: [String], digest: String)
    case unknown(id: String, cosId: String, createdAt: Timestamp, kind: String, raw: JSONValue)

    public var id: String {
        switch self {
        case let .message(id, _, _, _, _), let .ticketCreated(id, _, _, _, _, _), let .ticketMoved(id, _, _, _, _, _, _),
             let .eventBatch(id, _, _, _, _, _), let .unknown(id, _, _, _, _):
            id
        }
    }

    public var createdAt: Timestamp {
        switch self {
        case let .message(_, _, t, _, _), let .ticketCreated(_, _, t, _, _, _), let .ticketMoved(_, _, t, _, _, _, _),
             let .eventBatch(_, _, t, _, _, _), let .unknown(_, _, t, _, _):
            t
        }
    }

    public var kind: String {
        switch self {
        case .message: "message"
        case .ticketCreated: "ticket_created"
        case .ticketMoved: "ticket_moved"
        case .eventBatch: "event_batch"
        case let .unknown(_, _, _, kind, _): kind
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let id = try c.decode(String.self, forKey: "id")
        let cosId = try c.decode(String.self, forKey: "cosId")
        let at = try c.decode(Timestamp.self, forKey: "createdAt")
        let kind = try c.decode(String.self, forKey: "kind")
        switch kind {
        case "message":
            self = .message(id: id, cosId: cosId, createdAt: at, role: try c.decode(String.self, forKey: "role"), text: try c.decode(String.self, forKey: "text"))
        case "ticket_created":
            self = .ticketCreated(
                id: id, cosId: cosId, createdAt: at, key: try c.decode(String.self, forKey: "key"), title: try c.decode(String.self, forKey: "title"),
                status: try c.decode(String.self, forKey: "status"))
        case "ticket_moved":
            self = .ticketMoved(
                id: id, cosId: cosId, createdAt: at, key: try c.decode(String.self, forKey: "key"), title: try c.decode(String.self, forKey: "title"),
                from: try c.decode(String.self, forKey: "from"), to: try c.decode(String.self, forKey: "to"))
        case "event_batch":
            self = .eventBatch(
                id: id, cosId: cosId, createdAt: at, wakeId: try c.decode(String.self, forKey: "wakeId"),
                eventIds: try c.decode([String].self, forKey: "eventIds"), digest: try c.decode(String.self, forKey: "digest"))
        default:
            self = .unknown(id: id, cosId: cosId, createdAt: at, kind: kind, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, _, _, _, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(kind, forKey: "kind")
        switch self {
        case let .message(id, cosId, at, role, text):
            try c.encode(id, forKey: "id"); try c.encode(cosId, forKey: "cosId"); try c.encode(at, forKey: "createdAt")
            try c.encode(role, forKey: "role"); try c.encode(text, forKey: "text")
        case let .ticketCreated(id, cosId, at, key, title, status):
            try c.encode(id, forKey: "id"); try c.encode(cosId, forKey: "cosId"); try c.encode(at, forKey: "createdAt")
            try c.encode(key, forKey: "key"); try c.encode(title, forKey: "title"); try c.encode(status, forKey: "status")
        case let .ticketMoved(id, cosId, at, key, title, from, to):
            try c.encode(id, forKey: "id"); try c.encode(cosId, forKey: "cosId"); try c.encode(at, forKey: "createdAt")
            try c.encode(key, forKey: "key"); try c.encode(title, forKey: "title"); try c.encode(from, forKey: "from"); try c.encode(to, forKey: "to")
        case let .eventBatch(id, cosId, at, wakeId, eventIds, digest):
            try c.encode(id, forKey: "id"); try c.encode(cosId, forKey: "cosId"); try c.encode(at, forKey: "createdAt")
            try c.encode(wakeId, forKey: "wakeId"); try c.encode(eventIds, forKey: "eventIds"); try c.encode(digest, forKey: "digest")
        case .unknown: break
        }
    }
}

/// GET /cos/:id/transcript, newest page first
public struct CosChatPage: Codable, Sendable, Equatable {
    public var entries: [CosChatEntry]
    @Nullable public var nextCursor: String?

    public init(entries: [CosChatEntry], nextCursor: String? = nil) {
        self.entries = entries
        self.nextCursor = nextCursor
    }
}

/// A chief's memory (GET /tickets/:key/memory): one markdown document and the revision a write is checked against.
public struct CosMemory: Codable, Sendable, Equatable {
    public var text: String
    public var revision: String

    public init(text: String, revision: String) {
        self.text = text
        self.revision = revision
    }
}

/// PUT /tickets/:key/memory
public struct PutCosMemoryBody: Codable, Sendable, Equatable {
    public var text: String
    /// The revision the editor opened; a memory that changed since answers 409 with a `MemoryConflict`.
    public var baseRevision: String

    public init(text: String, baseRevision: String) {
        self.text = text
        self.baseRevision = baseRevision
    }
}

/// The `data` of PUT /tickets/:key/memory's 409.
public struct MemoryConflict: Codable, Sendable, Equatable {
    public var currentRevision: String
    public var text: String

    public init(currentRevision: String, text: String) {
        self.currentRevision = currentRevision
        self.text = text
    }
}

/// POST /cos/:id/messages
public struct CosMessageBody: Codable, Sendable, Equatable {
    public var text: String
    public init(text: String) { self.text = text }
}

/// POST /cos
public struct OpenCosBody: Codable, Sendable, Equatable {
    public var scope: String
    public init(scope: String) { self.scope = scope }
}

/// Bus events for the Inbox and chat. They travel in the same `{type: "event"}` frames but aren't
/// part of `HarnessEvent`, which decodes them as `.unknown`; `init?(event:)` reads them from there.
public enum CosBusEvent: Codable, Sendable, Equatable {
    case eventUpserted(CosEvent)
    case badge(CosBadge)
    case transcriptAppended(cosId: String, entry: CosChatEntry)

    /// The CoS event an unknown `HarnessEvent` carries, or nil for any other event.
    public init?(event: HarnessEvent) {
        guard case let .unknown(kind, raw) = event, kind.hasPrefix("cos."),
              let data = try? JSONEncoder().encode(raw),
              let decoded = try? JSONDecoder().decode(CosBusEvent.self, from: data)
        else { return nil }
        self = decoded
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        switch try c.decode(String.self, forKey: "kind") {
        case "cos.event.upserted": self = .eventUpserted(try c.decode(CosEvent.self, forKey: "event"))
        case "cos.badge": self = .badge(CosBadge(total: try c.decode(Int.self, forKey: "total"), byCos: try c.decode([String: Int].self, forKey: "byCos")))
        case "cos.transcript.appended":
            self = .transcriptAppended(cosId: try c.decode(String.self, forKey: "cosId"), entry: try c.decode(CosChatEntry.self, forKey: "entry"))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: "kind", in: c, debugDescription: "Unknown CoS event \(other)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        switch self {
        case let .eventUpserted(event):
            try c.encode("cos.event.upserted", forKey: "kind")
            try c.encode(event, forKey: "event")
        case let .badge(badge):
            try c.encode("cos.badge", forKey: "kind")
            try c.encode(badge.total, forKey: "total")
            try c.encode(badge.byCos, forKey: "byCos")
        case let .transcriptAppended(cosId, entry):
            try c.encode("cos.transcript.appended", forKey: "kind")
            try c.encode(cosId, forKey: "cosId")
            try c.encode(entry, forKey: "entry")
        }
    }
}

/// What POST /cos/:id/messages answers.
public struct CosMessageSent: Codable, Sendable, Equatable {
    public var entryId: String
    public init(entryId: String) { self.entryId = entryId }
}
