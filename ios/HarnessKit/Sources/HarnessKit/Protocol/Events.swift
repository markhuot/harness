import Foundation

// ---------------------------------------------------------------------------
// Events (service → client over WebSocket)
// ---------------------------------------------------------------------------

/// A change the service broadcasts, discriminated by `kind` (23 kinds). An unknown `kind`
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
    case activityAdded(entry: ActivityEntry)
    /// A new spec revision; the ticket.upserted that follows carries the new body. Services from
    /// before runId / runKind / createdAt omit them.
    case specRevised(ticketId: String, rev: Int, author: SpecRevisionAuthor, note: String, runId: Patch<String> = .absent, runKind: Patch<RunKind> = .absent, createdAt: Timestamp? = nil)
    case watcherUpserted(watcher: Watcher)
    case watcherDeleted(id: String)
    case settingsUpdated(settings: PublicSettings)
    /// A push device registered, changed or was removed: refetch GET /notifications
    case devicesChanged
    /// `tabId`: the tab the frame is from (services before browser tabs omit it). `viewerId`: the
    /// viewer the frame/state is for, echoed from its `browser.subscribe` (nil when it sent none,
    /// or from services before viewers).
    case browserFrame(sessionId: String, tabId: Int? = nil, data: String, width: Int, height: Int, viewerId: String? = nil)
    case browserState(sessionId: String, state: BrowserState, viewerId: String? = nil)
    /// The service's code on disk changed since it started (or changed back)
    case serviceStatus(status: ServiceStatus)
    /// Plan usage (GET /usage) was fetched again
    case usageUpdated(usage: PlanUsageReport)
    /// A terminal was created, or its title, cwd, process, size or state changed (about once a second at most).
    case terminalCreated(terminal: TerminalInfo)
    case terminalUpdated(terminal: TerminalInfo)
    case terminalRemoved(id: String)
    case unknown(kind: String, raw: JSONValue)

    /// Every `kind` this build knows, in protocol.ts order.
    public static let knownKinds = [
        "project.upserted", "project.deleted", "ticket.upserted", "ticket.deleted", "session.upserted",
        "session.deleted", "run.upserted", "transcript.appended", "subagent.upserted", "transcript.delta",
        "activity.added", "spec.revised", "watcher.upserted", "watcher.deleted", "settings.updated", "devices.changed",
        "browser.frame", "browser.state", "service.status", "usage.updated",
        "terminal.created", "terminal.updated", "terminal.removed",
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
        case .activityAdded: "activity.added"
        case .specRevised: "spec.revised"
        case .watcherUpserted: "watcher.upserted"
        case .watcherDeleted: "watcher.deleted"
        case .settingsUpdated: "settings.updated"
        case .devicesChanged: "devices.changed"
        case .browserFrame: "browser.frame"
        case .browserState: "browser.state"
        case .serviceStatus: "service.status"
        case .usageUpdated: "usage.updated"
        case .terminalCreated: "terminal.created"
        case .terminalUpdated: "terminal.updated"
        case .terminalRemoved: "terminal.removed"
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
        case "activity.added": self = .activityAdded(entry: try field("entry"))
        case "spec.revised":
            self = .specRevised(
                ticketId: try field("ticketId"), rev: try field("rev"), author: try field("author"), note: try field("note"),
                runId: try c.decode(Patch<String>.self, forKey: "runId"), runKind: try c.decode(Patch<RunKind>.self, forKey: "runKind"),
                createdAt: try c.decodeIfPresent(Timestamp.self, forKey: "createdAt"))
        case "watcher.upserted": self = .watcherUpserted(watcher: try field("watcher"))
        case "watcher.deleted": self = .watcherDeleted(id: try field("id"))
        case "settings.updated": self = .settingsUpdated(settings: try field("settings"))
        case "devices.changed": self = .devicesChanged
        case "browser.frame":
            self = .browserFrame(
                sessionId: try field("sessionId"), tabId: try c.decodeIfPresent(Int.self, forKey: "tabId"), data: try field("data"),
                width: try field("width"), height: try field("height"), viewerId: try c.decodeIfPresent(String.self, forKey: "viewerId"))
        case "browser.state":
            self = .browserState(
                sessionId: try field("sessionId"), state: try field("state"), viewerId: try c.decodeIfPresent(String.self, forKey: "viewerId"))
        case "service.status": self = .serviceStatus(status: try field("status"))
        case "usage.updated": self = .usageUpdated(usage: try field("usage"))
        case "terminal.created": self = .terminalCreated(terminal: try field("terminal"))
        case "terminal.updated": self = .terminalUpdated(terminal: try field("terminal"))
        case "terminal.removed": self = .terminalRemoved(id: try field("id"))
        default: self = .unknown(kind: kind, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(kind, forKey: "kind")
        switch self {
        case let .projectUpserted(project): try c.encode(project, forKey: "project")
        case let .projectDeleted(id), let .ticketDeleted(id), let .sessionDeleted(id), let .watcherDeleted(id), let .terminalRemoved(id):
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
        case let .activityAdded(entry): try c.encode(entry, forKey: "entry")
        case let .specRevised(ticketId, rev, author, note, runId, runKind, createdAt):
            try c.encode(ticketId, forKey: "ticketId")
            try c.encode(rev, forKey: "rev")
            try c.encode(author, forKey: "author")
            try c.encode(note, forKey: "note")
            try c.encode(runId, forKey: "runId")
            try c.encode(runKind, forKey: "runKind")
            try c.encodeIfPresent(createdAt, forKey: "createdAt")
        case let .watcherUpserted(watcher): try c.encode(watcher, forKey: "watcher")
        case let .settingsUpdated(settings): try c.encode(settings, forKey: "settings")
        case let .browserFrame(sessionId, tabId, data, width, height, viewerId):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encodeIfPresent(tabId, forKey: "tabId")
            try c.encode(data, forKey: "data")
            try c.encode(width, forKey: "width")
            try c.encode(height, forKey: "height")
            try c.encodeIfPresent(viewerId, forKey: "viewerId")
        case let .browserState(sessionId, state, viewerId):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encode(state, forKey: "state")
            try c.encodeIfPresent(viewerId, forKey: "viewerId")
        case let .serviceStatus(status): try c.encode(status, forKey: "status")
        case let .usageUpdated(usage): try c.encode(usage, forKey: "usage")
        case let .terminalCreated(terminal), let .terminalUpdated(terminal): try c.encode(terminal, forKey: "terminal")
        case .devicesChanged, .unknown: break
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
    /// open one); subscribing again with another `tabId` switches this viewer to that tab.
    /// `viewerId` names one viewer on this socket (up to 64 of `[A-Za-z0-9_.:-]`), so one socket can
    /// watch several tabs of a session at once; without it the socket is a single viewer.
    case browserSubscribe(sessionId: String, tabId: Int? = nil, viewerId: String? = nil)
    case browserUnsubscribe(sessionId: String, viewerId: String? = nil)
    /// `tabId`: the tab the input is for (nil: the tab this viewer watches).
    case browserInput(sessionId: String, tabId: Int? = nil, input: BrowserInput, viewerId: String? = nil)
    /// What this socket shows; replaces its earlier presence. Notifications for tickets a visible
    /// presence lists are suppressed.
    case presence(Presence)
    /// Watch a terminal and report this client's viewport: the service answers with a snapshot, then
    /// live output. The client counts toward the shell's size while attached; detach removes it.
    case terminalAttach(id: String, deviceId: String, cols: Int, rows: Int)
    case terminalDetach(id: String)
    case terminalResize(id: String, cols: Int, rows: Int)
    case terminalWrite(id: String, data: String)
    /// A Mac's answer to an `app.request` (the payload is the Mac app's business: iOS never sends one).
    case appReply(id: String, reply: JSONValue)
    case ping
    case unknown(type: String, raw: JSONValue)

    public var type: String {
        switch self {
        case .hello: "hello"
        case .browserSubscribe: "browser.subscribe"
        case .browserUnsubscribe: "browser.unsubscribe"
        case .browserInput: "browser.input"
        case .presence: "presence"
        case .terminalAttach: "terminal.attach"
        case .terminalDetach: "terminal.detach"
        case .terminalResize: "terminal.resize"
        case .terminalWrite: "terminal.write"
        case .appReply: "app.reply"
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
            self = .browserSubscribe(
                sessionId: try c.decode(String.self, forKey: "sessionId"), tabId: try c.decodeIfPresent(Int.self, forKey: "tabId"),
                viewerId: try c.decodeIfPresent(String.self, forKey: "viewerId"))
        case "browser.unsubscribe":
            self = .browserUnsubscribe(
                sessionId: try c.decode(String.self, forKey: "sessionId"), viewerId: try c.decodeIfPresent(String.self, forKey: "viewerId"))
        case "browser.input":
            self = .browserInput(
                sessionId: try c.decode(String.self, forKey: "sessionId"), tabId: try c.decodeIfPresent(Int.self, forKey: "tabId"),
                input: try c.decode(BrowserInput.self, forKey: "input"), viewerId: try c.decodeIfPresent(String.self, forKey: "viewerId"))
        case "presence": self = .presence(try Presence(from: decoder))
        case "terminal.attach":
            self = .terminalAttach(id: try c.decode(String.self, forKey: "id"), deviceId: try c.decode(String.self, forKey: "deviceId"), cols: try c.decode(Int.self, forKey: "cols"), rows: try c.decode(Int.self, forKey: "rows"))
        case "terminal.detach": self = .terminalDetach(id: try c.decode(String.self, forKey: "id"))
        case "terminal.resize": self = .terminalResize(id: try c.decode(String.self, forKey: "id"), cols: try c.decode(Int.self, forKey: "cols"), rows: try c.decode(Int.self, forKey: "rows"))
        case "terminal.write": self = .terminalWrite(id: try c.decode(String.self, forKey: "id"), data: try c.decode(String.self, forKey: "data"))
        case "app.reply": self = .appReply(id: try c.decode(String.self, forKey: "id"), reply: try c.decode(JSONValue.self, forKey: "reply"))
        case "ping": self = .ping
        default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        if case let .presence(presence) = self {
            try presence.encode(to: encoder)
            var c = encoder.container(keyedBy: AnyCodingKey.self)
            try c.encode(type, forKey: "type")
            return
        }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(type, forKey: "type")
        switch self {
        case let .hello(client): try c.encode(client, forKey: "client")
        case let .browserSubscribe(sessionId, tabId, viewerId):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encodeIfPresent(tabId, forKey: "tabId")
            try c.encodeIfPresent(viewerId, forKey: "viewerId")
        case let .browserUnsubscribe(sessionId, viewerId):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encodeIfPresent(viewerId, forKey: "viewerId")
        case let .browserInput(sessionId, tabId, input, viewerId):
            try c.encode(sessionId, forKey: "sessionId")
            try c.encodeIfPresent(tabId, forKey: "tabId")
            try c.encode(input, forKey: "input")
            try c.encodeIfPresent(viewerId, forKey: "viewerId")
        case let .terminalAttach(id, deviceId, cols, rows):
            try c.encode(id, forKey: "id")
            try c.encode(deviceId, forKey: "deviceId")
            try c.encode(cols, forKey: "cols")
            try c.encode(rows, forKey: "rows")
        case let .terminalDetach(id): try c.encode(id, forKey: "id")
        case let .terminalResize(id, cols, rows):
            try c.encode(id, forKey: "id")
            try c.encode(cols, forKey: "cols")
            try c.encode(rows, forKey: "rows")
        case let .terminalWrite(id, data):
            try c.encode(id, forKey: "id")
            try c.encode(data, forKey: "data")
        case let .appReply(id, reply):
            try c.encode(id, forKey: "id")
            try c.encode(reply, forKey: "reply")
        case .presence, .ping, .unknown: break
        }
    }
}

/// Service → client, discriminated by `type`. An unknown `type` decodes to `.unknown(type:raw:)`.
public enum ServerMessage: Codable, Sendable, Equatable {
    case welcome(version: String)
    case event(HarnessEvent)
    case pong
    case error(message: String)
    /// The screen to restore (escape sequences for an empty emulator at cols × rows); live output continues at `offset`.
    case terminalSnapshot(id: String, data: String, offset: Int, cols: Int, rows: Int, truncated: Bool)
    /// Live output; `offset` is the byte offset just past `data`.
    case terminalOutput(id: String, data: String, offset: Int)
    case terminalExit(id: String, exitCode: Int?)
    /// Open a pane for this terminal (sent once, only to Mac clients).
    case terminalOpen(id: String, projectId: String?)
    /// Ask this Mac to do something in the app and answer with `app.reply` (the request is the Mac app's business: iOS ignores it).
    case appRequest(id: String, request: JSONValue)
    case unknown(type: String, raw: JSONValue)

    public var type: String {
        switch self {
        case .welcome: "welcome"
        case .event: "event"
        case .pong: "pong"
        case .error: "error"
        case .terminalSnapshot: "terminal.snapshot"
        case .terminalOutput: "terminal.output"
        case .terminalExit: "terminal.exit"
        case .terminalOpen: "terminal.open"
        case .appRequest: "app.request"
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
        case "terminal.snapshot":
            self = .terminalSnapshot(
                id: try c.decode(String.self, forKey: "id"), data: try c.decode(String.self, forKey: "data"), offset: try c.decode(Int.self, forKey: "offset"),
                cols: try c.decode(Int.self, forKey: "cols"), rows: try c.decode(Int.self, forKey: "rows"), truncated: try c.decode(Bool.self, forKey: "truncated"))
        case "terminal.output":
            self = .terminalOutput(id: try c.decode(String.self, forKey: "id"), data: try c.decode(String.self, forKey: "data"), offset: try c.decode(Int.self, forKey: "offset"))
        case "terminal.exit": self = .terminalExit(id: try c.decode(String.self, forKey: "id"), exitCode: try c.decodeIfPresent(Int.self, forKey: "exitCode"))
        case "terminal.open": self = .terminalOpen(id: try c.decode(String.self, forKey: "id"), projectId: try c.decodeIfPresent(String.self, forKey: "projectId"))
        case "app.request": self = .appRequest(id: try c.decode(String.self, forKey: "id"), request: try c.decode(JSONValue.self, forKey: "request"))
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
        case let .terminalSnapshot(id, data, offset, cols, rows, truncated):
            try c.encode(id, forKey: "id")
            try c.encode(data, forKey: "data")
            try c.encode(offset, forKey: "offset")
            try c.encode(cols, forKey: "cols")
            try c.encode(rows, forKey: "rows")
            try c.encode(truncated, forKey: "truncated")
        case let .terminalOutput(id, data, offset):
            try c.encode(id, forKey: "id")
            try c.encode(data, forKey: "data")
            try c.encode(offset, forKey: "offset")
        case let .terminalExit(id, exitCode):
            try c.encode(id, forKey: "id")
            if let exitCode { try c.encode(exitCode, forKey: "exitCode") } else { try c.encodeNil(forKey: "exitCode") }
        case let .terminalOpen(id, projectId):
            try c.encode(id, forKey: "id")
            if let projectId { try c.encode(projectId, forKey: "projectId") } else { try c.encodeNil(forKey: "projectId") }
        case let .appRequest(id, request):
            try c.encode(id, forKey: "id")
            try c.encode(request, forKey: "request")
        case .pong, .unknown: break
        }
    }
}
