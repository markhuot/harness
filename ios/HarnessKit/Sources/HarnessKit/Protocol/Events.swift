import Foundation

// ---------------------------------------------------------------------------
// Events (service → client over WebSocket)
// ---------------------------------------------------------------------------

/// A change the service broadcasts, discriminated by `kind` (17 kinds). An unknown `kind`
/// decodes to `.unknown(kind:raw:)` and re-encodes `raw` unchanged.
public enum HarnessEvent: Codable, Sendable, Equatable {
    case projectUpserted(project: Project)
    case projectDeleted(id: String)
    case ticketUpserted(ticket: Ticket)
    case ticketDeleted(id: String)
    case sessionUpserted(session: Session)
    case sessionDeleted(id: String)
    case runUpserted(run: Run)
    case transcriptAppended(entry: TranscriptEntry)
    case subagentUpserted(subagent: Subagent)
    /// Ephemeral streaming text; the full block is persisted later as transcript.appended
    case transcriptDelta(sessionId: String, runId: String, text: String)
    case summaryAdded(summary: Summary)
    case watcherUpserted(watcher: Watcher)
    case watcherDeleted(id: String)
    case settingsUpdated(settings: PublicSettings)
    /// `tabId`: the tab the frame is from (services before browser tabs omit it).
    case browserFrame(sessionId: String, tabId: Int? = nil, data: String, width: Int, height: Int)
    case browserState(sessionId: String, state: BrowserState)
    /// The service's code on disk changed since it started (or changed back)
    case serviceStatus(status: ServiceStatus)
    case unknown(kind: String, raw: JSONValue)

    /// Every `kind` this build knows, in protocol.ts order.
    public static let knownKinds = [
        "project.upserted", "project.deleted", "ticket.upserted", "ticket.deleted", "session.upserted",
        "session.deleted", "run.upserted", "transcript.appended", "subagent.upserted", "transcript.delta",
        "summary.added", "watcher.upserted", "watcher.deleted", "settings.updated", "browser.frame",
        "browser.state", "service.status",
    ]

    /// The wire discriminator.
    public var kind: String {
        switch self {
        case .projectUpserted: "project.upserted"
        case .projectDeleted: "project.deleted"
        case .ticketUpserted: "ticket.upserted"
        case .ticketDeleted: "ticket.deleted"
        case .sessionUpserted: "session.upserted"
        case .sessionDeleted: "session.deleted"
        case .runUpserted: "run.upserted"
        case .transcriptAppended: "transcript.appended"
        case .subagentUpserted: "subagent.upserted"
        case .transcriptDelta: "transcript.delta"
        case .summaryAdded: "summary.added"
        case .watcherUpserted: "watcher.upserted"
        case .watcherDeleted: "watcher.deleted"
        case .settingsUpdated: "settings.updated"
        case .browserFrame: "browser.frame"
        case .browserState: "browser.state"
        case .serviceStatus: "service.status"
        case let .unknown(kind, _): kind
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let kind = try c.decode(String.self, forKey: "kind")
        func field<T: Decodable>(_ key: AnyCodingKey, _ type: T.Type = T.self) throws -> T {
            try c.decode(T.self, forKey: key)
        }
        switch kind {
        case "project.upserted": self = .projectUpserted(project: try field("project"))
        case "project.deleted": self = .projectDeleted(id: try field("id"))
        case "ticket.upserted": self = .ticketUpserted(ticket: try field("ticket"))
        case "ticket.deleted": self = .ticketDeleted(id: try field("id"))
        case "session.upserted": self = .sessionUpserted(session: try field("session"))
        case "session.deleted": self = .sessionDeleted(id: try field("id"))
        case "run.upserted": self = .runUpserted(run: try field("run"))
        case "transcript.appended": self = .transcriptAppended(entry: try field("entry"))
        case "subagent.upserted": self = .subagentUpserted(subagent: try field("subagent"))
        case "transcript.delta":
            self = .transcriptDelta(sessionId: try field("sessionId"), runId: try field("runId"), text: try field("text"))
        case "summary.added": self = .summaryAdded(summary: try field("summary"))
        case "watcher.upserted": self = .watcherUpserted(watcher: try field("watcher"))
        case "watcher.deleted": self = .watcherDeleted(id: try field("id"))
        case "settings.updated": self = .settingsUpdated(settings: try field("settings"))
        case "browser.frame":
            self = .browserFrame(
                sessionId: try field("sessionId"), tabId: try c.decodeIfPresent(Int.self, forKey: "tabId"), data: try field("data"),
                width: try field("width"), height: try field("height"))
        case "browser.state": self = .browserState(sessionId: try field("sessionId"), state: try field("state"))
        case "service.status": self = .serviceStatus(status: try field("status"))
        default: self = .unknown(kind: kind, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(kind, forKey: "kind")
        switch self {
        case let .projectUpserted(project): try c.encode(project, forKey: "project")
        case let .projectDeleted(id), let .ticketDeleted(id), let .sessionDeleted(id), let .watcherDeleted(id):
            try c.encode(id, forKey: "id")
        case let .ticketUpserted(ticket): try c.encode(ticket, forKey: "ticket")
        case let .sessionUpserted(session): try c.encode(session, forKey: "session")
        case let .runUpserted(run): try c.encode(run, forKey: "run")
        case let .transcriptAppended(entry): try c.encode(entry, forKey: "entry")
        case let .subagentUpserted(subagent): try c.encode(subagent, forKey: "subagent")
        case let .transcriptDelta(sessionId, runId, text):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encode(runId, forKey: "runId")
            try c.encode(text, forKey: "text")
        case let .summaryAdded(summary): try c.encode(summary, forKey: "summary")
        case let .watcherUpserted(watcher): try c.encode(watcher, forKey: "watcher")
        case let .settingsUpdated(settings): try c.encode(settings, forKey: "settings")
        case let .browserFrame(sessionId, tabId, data, width, height):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encodeIfPresent(tabId, forKey: "tabId")
            try c.encode(data, forKey: "data")
            try c.encode(width, forKey: "width")
            try c.encode(height, forKey: "height")
        case let .browserState(sessionId, state):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encode(state, forKey: "state")
        case let .serviceStatus(status): try c.encode(status, forKey: "status")
        case .unknown: break
        }
    }
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

/// Client → service, discriminated by `type`.
public enum ClientMessage: Codable, Sendable, Equatable {
    case hello(client: String)
    /// Watch a session's browser. `tabId` picks the tab (nil, or a tab that has closed: the lowest
    /// open one); subscribing again with another `tabId` switches this socket to that tab.
    case browserSubscribe(sessionId: String, tabId: Int? = nil)
    case browserUnsubscribe(sessionId: String)
    /// `tabId`: the tab the input is for (nil: the tab this socket watches).
    case browserInput(sessionId: String, tabId: Int? = nil, input: BrowserInput)
    case ping
    case unknown(type: String, raw: JSONValue)

    public var type: String {
        switch self {
        case .hello: "hello"
        case .browserSubscribe: "browser.subscribe"
        case .browserUnsubscribe: "browser.unsubscribe"
        case .browserInput: "browser.input"
        case .ping: "ping"
        case let .unknown(type, _): type
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let type = try c.decode(String.self, forKey: "type")
        switch type {
        case "hello": self = .hello(client: try c.decode(String.self, forKey: "client"))
        case "browser.subscribe":
            self = .browserSubscribe(sessionId: try c.decode(String.self, forKey: "sessionId"), tabId: try c.decodeIfPresent(Int.self, forKey: "tabId"))
        case "browser.unsubscribe": self = .browserUnsubscribe(sessionId: try c.decode(String.self, forKey: "sessionId"))
        case "browser.input":
            self = .browserInput(
                sessionId: try c.decode(String.self, forKey: "sessionId"), tabId: try c.decodeIfPresent(Int.self, forKey: "tabId"),
                input: try c.decode(BrowserInput.self, forKey: "input"))
        case "ping": self = .ping
        default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(type, forKey: "type")
        switch self {
        case let .hello(client): try c.encode(client, forKey: "client")
        case let .browserSubscribe(sessionId, tabId):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encodeIfPresent(tabId, forKey: "tabId")
        case let .browserUnsubscribe(sessionId):
            try c.encode(sessionId, forKey: "sessionId")
        case let .browserInput(sessionId, tabId, input):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encodeIfPresent(tabId, forKey: "tabId")
            try c.encode(input, forKey: "input")
        case .ping, .unknown: break
        }
    }
}

/// Service → client, discriminated by `type`. An unknown `type` decodes to `.unknown(type:raw:)`.
public enum ServerMessage: Codable, Sendable, Equatable {
    case welcome(version: String)
    case event(HarnessEvent)
    case pong
    case error(message: String)
    case unknown(type: String, raw: JSONValue)

    public var type: String {
        switch self {
        case .welcome: "welcome"
        case .event: "event"
        case .pong: "pong"
        case .error: "error"
        case let .unknown(type, _): type
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let type = try c.decode(String.self, forKey: "type")
        switch type {
        case "welcome": self = .welcome(version: try c.decode(String.self, forKey: "version"))
        case "event": self = .event(try c.decode(HarnessEvent.self, forKey: "event"))
        case "pong": self = .pong
        case "error": self = .error(message: try c.decode(String.self, forKey: "message"))
        default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(type, forKey: "type")
        switch self {
        case let .welcome(version): try c.encode(version, forKey: "version")
        case let .event(event): try c.encode(event, forKey: "event")
        case let .error(message): try c.encode(message, forKey: "message")
        case .pong, .unknown: break
        }
    }
}
