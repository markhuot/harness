import Foundation

// Thin typed client for the harness service: the Swift port of shared/src/client.ts. Every method
// keeps the TS path, method, body and query shape; labels are Swift-style.

/// The harness service's REST API.
///
/// A `final class: Sendable` rather than an actor: everything it holds (`baseUrl`, `token`,
/// `transport`) is immutable, so there's no state to isolate. That keeps the URL builders
/// (`attachmentUrl`, `pluginUiUrl`) and `connect()` synchronous, so views can call them without
/// `await`, and lets requests run concurrently without hopping through an actor's executor. The
/// mutable part, the reconnecting socket, is `HarnessSocket` (an actor).
public final class HarnessClient: Sendable {
    /// `http://127.0.0.1:7717`, without a trailing slash.
    public let baseUrl: String
    /// The bearer token (hosts hand it to plugin frames in harness:init).
    public let token: String
    public let transport: any HTTPTransport

    public init(baseUrl: String, token: String, transport: any HTTPTransport = URLSessionTransport()) {
        // `.replace(/\/$/, "")`: one trailing slash.
        self.baseUrl = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        self.token = token
        self.transport = transport
    }

    // MARK: Envelope

    /// One request: bearer auth, a JSON body when there is one, `{ data }` back. A non-2xx status
    /// throws `HarnessAPIError(status, json.error ?? statusText, json.data)`.
    public func request<T: Decodable>(_ method: String, _ path: String, as type: T.Type = T.self) async throws -> T {
        try await send(method, path, body: nil)
    }

    /// `request` with a JSON body (encoded with Patch semantics: `.absent` keys are left out).
    public func request<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B, as type: T.Type = T.self) async throws -> T {
        try await send(method, path, body: try Self.encoder.encode(body))
    }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    private func send<T: Decodable>(_ method: String, _ path: String, body: Data?) async throws -> T {
        guard let url = URL(string: baseUrl + path) else { throw URLError(.badURL) }
        var headers = ["authorization": "Bearer \(token)"]
        if body != nil { headers["content-type"] = "application/json" }
        let res = try await transport.send(HTTPRequest(method: method, url: url, headers: headers, body: body))
        // An empty response text is `{}`.
        let text = res.body.isEmpty ? Data("{}".utf8) : res.body
        guard res.ok else { throw Self.apiError(status: res.status, body: text) }
        return try JSONDecoder().decode(Envelope<T>.self, from: text).data
    }

    /// The error for a non-2xx response. A body that isn't JSON (a proxy's HTML page) still gives a
    /// HarnessAPIError, with the status text as its message.
    static func apiError(status: Int, body: Data) -> HarnessAPIError {
        let statusText = HTTPURLResponse.localizedString(forStatusCode: status)
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: body) else {
            return HarnessAPIError(status: status, message: statusText)
        }
        let data = json["data"].flatMap { $0 == .null ? nil : $0 }
        return HarnessAPIError(status: status, message: json["error"]?.stringValue ?? statusText, data: data)
    }

    /// `{ data }`. A missing `data` decodes as `null`, so optional results (browserState) are nil
    /// and required ones fail to decode.
    struct Envelope<T: Decodable>: Decodable {
        let data: T
        enum CodingKeys: String, CodingKey { case data }
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if c.contains(.data) {
                data = try c.decode(T.self, forKey: .data)
            } else {
                data = try JSONDecoder().decode(T.self, from: Data("null".utf8))
            }
        }
    }

    /// The /files query: `q`, `limit`, `ignored=1` when true, `kind`.
    static func fileSearchQuery(_ q: String, _ opts: FileSearchOptions) -> String {
        Query.build([("q", .str(q)), ("limit", .int(opts.limit)), ("ignored", opts.ignored == true ? 1 : nil), ("kind", .str(opts.kind?.rawValue))])
    }

    // MARK: Service

    public func health() async throws -> Health {
        try await request("GET", "/health")
    }

    /// Restart the service now (it exits and launchd starts it again). Running agents are stopped.
    public func restartService() async throws -> OkResponse {
        try await request("POST", "/service/restart")
    }

    // MARK: Projects

    public func listProjects() async throws -> [Project] {
        try await request("GET", "/projects")
    }

    public func createProject(_ body: CreateProjectBody) async throws -> Project {
        try await request("POST", "/projects", body: body)
    }

    public func updateProject(_ id: String, _ body: UpdateProjectBody) async throws -> Project {
        try await request("PATCH", "/projects/\(id)", body: body)
    }

    public func deleteProject(_ id: String) async throws -> OkResponse {
        try await request("DELETE", "/projects/\(id)")
    }

    /// Files and folders in the project folder matching `q`, for @-mentions in a new session. The file
    /// browser passes `ignored: true` to search node_modules too, and `kind: .file` for files only.
    public func projectFiles(_ id: String, q: String, _ options: FileSearchOptions = FileSearchOptions()) async throws -> [FileMatch] {
        try await request("GET", "/projects/\(id)/files\(Self.fileSearchQuery(q, options))")
    }

    /// The bare-number form (the autocomplete's older call shape): `limit` only.
    public func projectFiles(_ id: String, q: String, limit: Int) async throws -> [FileMatch] {
        try await projectFiles(id, q: q, FileSearchOptions(limit: limit))
    }

    /// Slash commands and skills matching `q` that a new session's agent (`driver`, default: the
    /// project's) offers in the project folder, for the `/command` autocomplete. [] when it has none.
    public func projectCommands(_ id: String, q: String, driver: String? = nil, limit: Int? = nil) async throws -> [CommandMatch] {
        try await request("GET", "/projects/\(id)/commands\(Query.build([("q", .str(q)), ("driver", .str(driver)), ("limit", .int(limit))]))")
    }

    /// A file in the project folder, read from disk, and where it stands in git.
    public func projectFile(_ id: String, path: String) async throws -> FileView {
        try await request("GET", "/projects/\(id)/file\(Query.build([("path", .str(path))]))")
    }

    /// A project file's uncommitted changes against HEAD (409 outside a git repository).
    public func projectFileDiff(_ id: String, path: String) async throws -> FileDiff {
        try await request("GET", "/projects/\(id)/file/diff\(Query.build([("path", .str(path))]))")
    }

    /// The project's local branches (most recent first) matching `q`, for the new-session branch picker.
    public func projectBranches(_ id: String, q: String? = nil, limit: Int? = nil) async throws -> [BranchInfo] {
        try await request("GET", "/projects/\(id)/branches\(Query.build([("q", .str(q)), ("limit", .int(limit))]))")
    }

    // MARK: Tickets

    /// Every ticket (optionally one project's), or only those in `status` (e.g. all but done).
    public func listTickets(projectId: String? = nil, status: [TicketStatus] = []) async throws -> [Ticket] {
        let s = status.isEmpty ? nil : status.map(\.rawValue).joined(separator: ",")
        return try await request("GET", "/tickets\(Query.build([("projectId", .str(projectId)), ("status", .str(s))]))")
    }

    /// One page of a single column. done pages newest-completed first; other statuses by position.
    /// `q` narrows to tickets matching the search. Pass the previous page's nextCursor as `cursor`.
    public func ticketPage(status: TicketStatus, projectId: String? = nil, q: String? = nil, limit: Int? = nil, cursor: String? = nil) async throws -> TicketPage {
        let query = Query.build([
            ("status", .str(status.rawValue)), ("projectId", .str(projectId)), ("q", .str(q)), ("limit", .int(limit)), ("cursor", .str(cursor)),
        ])
        return try await request("GET", "/tickets/page\(query)")
    }

    /// Search every status: key (current or pre-rename, exact/prefix), title, description and the
    /// latest summary. Key matches rank first, then title, then the rest; newest first within a rank.
    /// An empty/whitespace `q` is a 400.
    public func searchTickets(q: String, projectId: String? = nil, limit: Int? = nil, cursor: String? = nil) async throws -> TicketPage {
        let query = Query.build([("q", .str(q)), ("projectId", .str(projectId)), ("limit", .int(limit)), ("cursor", .str(cursor))])
        return try await request("GET", "/tickets/search\(query)")
    }

    public func createTicket(_ body: CreateTicketBody) async throws -> Ticket {
        try await request("POST", "/tickets", body: body)
    }

    /// A 404 for a remote ID carries `RemoteKeyMatches` in the error's `data`.
    public func getTicket(_ key: String) async throws -> TicketDetail {
        try await request("GET", "/tickets/\(key)")
    }

    public func updateTicket(_ key: String, _ body: UpdateTicketBody) async throws -> Ticket {
        try await request("PATCH", "/tickets/\(key)", body: body)
    }

    public func deleteTicket(_ key: String) async throws -> OkResponse {
        try await request("DELETE", "/tickets/\(key)")
    }

    public func startTicket(_ key: String) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/start")
    }

    /// Launch a draft (Ticket.draft): start work now, or plan first.
    public func submitTicket(_ key: String, _ body: SubmitTicketBody) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/submit", body: body)
    }

    /// `move` is only sent when true.
    public func sendMessage(_ key: String, text: String, move: Bool = false) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/messages", body: MessageBody(text: text, move: move ? true : nil))
    }

    public func humanReview(_ key: String, _ body: HumanReviewBody) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/review", body: body)
    }

    public func reopenTicket(_ key: String, _ body: ReopenBody) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/reopen", body: body)
    }

    public func completeTicket(_ key: String, _ body: CompleteBody = CompleteBody()) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/complete", body: body)
    }

    public func answerApproval(_ key: String, _ body: ApprovalBody) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/approval", body: body)
    }

    public func rerunAgentReview(_ key: String) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/agent-review")
    }

    public func cancelTicket(_ key: String) async throws -> Ticket {
        try await request("POST", "/tickets/\(key)/cancel")
    }

    /// Files and folders where the ticket's agent works matching `q`, for @-mentions in a message
    /// (options as projectFiles).
    public func ticketFiles(_ key: String, q: String, _ options: FileSearchOptions = FileSearchOptions()) async throws -> [FileMatch] {
        try await request("GET", "/tickets/\(key)/files\(Self.fileSearchQuery(q, options))")
    }

    /// The bare-number form: `limit` only.
    public func ticketFiles(_ key: String, q: String, limit: Int) async throws -> [FileMatch] {
        try await ticketFiles(key, q: q, FileSearchOptions(limit: limit))
    }

    /// Slash commands and skills matching `q` that the ticket's agent offers where it works, for
    /// `/command` in a message.
    public func ticketCommands(_ key: String, q: String, limit: Int? = nil) async throws -> [CommandMatch] {
        try await request("GET", "/tickets/\(key)/commands\(Query.build([("q", .str(q)), ("limit", .int(limit))]))")
    }

    /// A file where the ticket's agent works (its worktree, else its cwd, else the project folder).
    public func ticketFile(_ key: String, path: String) async throws -> FileView {
        try await request("GET", "/tickets/\(key)/file\(Query.build([("path", .str(path))]))")
    }

    /// That file's uncommitted changes against HEAD (409 outside a git repository).
    public func ticketFileDiff(_ key: String, path: String) async throws -> FileDiff {
        try await request("GET", "/tickets/\(key)/file/diff\(Query.build([("path", .str(path))]))")
    }

    public func listSummaries(_ key: String) async throws -> [Summary] {
        try await request("GET", "/tickets/\(key)/summaries")
    }

    /// Absolute URL of a summary attachment, token in the query so an image or video view can load it.
    public func attachmentUrl(_ id: String) -> String {
        "\(baseUrl)/attachments/\(URIComponent.encode(id))?token=\(URIComponent.encode(token))"
    }

    // MARK: Sessions (ticket + triage) and transcripts

    public func listSessions(kind: SessionKind? = nil) async throws -> [Session] {
        try await request("GET", "/sessions\(Query.build([("kind", .str(kind?.rawValue))]))")
    }

    public func getSession(_ id: String) async throws -> Session {
        try await request("GET", "/sessions/\(id)")
    }

    /// The session agent's transcript after `after` (a seq), or one sub-agent's with `subagentId`.
    public func transcript(_ sessionId: String, after: Int = 0, subagentId: String? = nil) async throws -> [TranscriptEntry] {
        let sub = subagentId.map { $0.isEmpty ? "" : "&subagent=\(URIComponent.encode($0))" } ?? ""
        return try await request("GET", "/sessions/\(sessionId)/transcript?after=\(after)\(sub)")
    }

    public func subagents(_ sessionId: String) async throws -> [Subagent] {
        try await request("GET", "/sessions/\(sessionId)/subagents")
    }

    // MARK: Watchers

    public func listWatchers() async throws -> [Watcher] {
        try await request("GET", "/watchers")
    }

    /// POST needs `name` and `command`; they override any in `body`.
    public func createWatcher(name: String, command: String, _ body: WatcherBody = WatcherBody()) async throws -> Watcher {
        var body = body
        body.name = name
        body.command = command
        return try await request("POST", "/watchers", body: body)
    }

    public func updateWatcher(_ id: String, _ body: WatcherBody) async throws -> Watcher {
        try await request("PATCH", "/watchers/\(id)", body: body)
    }

    public func deleteWatcher(_ id: String) async throws -> OkResponse {
        try await request("DELETE", "/watchers/\(id)")
    }

    public func runWatcher(_ id: String) async throws -> OkResponse {
        try await request("POST", "/watchers/\(id)/run")
    }

    /// Feed output directly, as if a watcher named `source` printed `text` (objects are sent as JSON
    /// text). `prompt` plays the watcher's prompt. nil when the same text was already seen.
    /// Useful for testing triage.
    public func injectOutput(source: String, text: JSONValue, prompt: String? = nil) async throws -> Session? {
        try await request("POST", "/watchers/inject", body: InjectOutputBody(source: source, text: text, prompt: prompt))
    }

    // MARK: Drivers & settings

    public func listDrivers() async throws -> [DriverInfo] {
        try await request("GET", "/drivers")
    }

    /// Models the driver offers (cached by the service; `refresh` re-queries the driver).
    public func listModels(_ driverId: String, refresh: Bool = false) async throws -> DriverModels {
        try await request("GET", "/drivers/\(URIComponent.encode(driverId))/models\(refresh ? "?refresh=1" : "")")
    }

    public func loginDriver(_ id: String) async throws -> DriverLoginResponse {
        try await request("POST", "/drivers/\(id)/login")
    }

    public func getSettings() async throws -> PublicSettings {
        try await request("GET", "/settings")
    }

    public func updateSettings(_ body: SettingsPatch) async throws -> PublicSettings {
        try await request("PATCH", "/settings", body: body)
    }

    /// Every overridable prompt with its built-in text and the user's override; change them with
    /// `updateSettings(SettingsPatch(prompts:))`.
    public func listPrompts() async throws -> [PromptEntry] {
        try await request("GET", "/prompts")
    }

    // MARK: Network & pairing

    /// Listen mode, bound addresses and Tailscale status.
    public func network() async throws -> NetworkStatus {
        try await request("GET", "/network")
    }

    /// The link a phone scans (409 in localhost mode: nothing off this machine can reach the service).
    public func pairing() async throws -> PairingInfo {
        try await request("GET", "/pairing")
    }

    /// Replace the bearer token. The old one stops working immediately (open sockets on it are
    /// closed), so callers must switch to the returned token: this client keeps using the old one.
    public func rotateToken() async throws -> RotateTokenResponse {
        try await request("POST", "/token/rotate")
    }

    // MARK: Browser

    /// nil when the session has no browser.
    public func browserState(_ sessionId: String) async throws -> BrowserState? {
        try await request("GET", "/browser/\(sessionId)")
    }

    public func browserNavigate(_ sessionId: String, url: String) async throws -> BrowserState {
        try await request("POST", "/browser/\(sessionId)/navigate", body: NavigateBody(url: url))
    }

    // MARK: Plugins

    public func listPlugins() async throws -> [PluginInfo] {
        try await request("GET", "/plugins")
    }

    /// Plugin tabs that apply to this ticket (the service evaluates each tab's `when`).
    public func ticketTabs(_ key: String) async throws -> [PluginTab] {
        try await request("GET", "/tickets/\(key)/tabs")
    }

    /// The page a plugin tab's web view loads: `pluginUiUrl` in shared/src/state/pluginBridge.ts.
    public func pluginUiUrl(pluginId: String, tabId: String) -> String {
        Self.pluginUiUrl(baseUrl: baseUrl, pluginId: pluginId, tabId: tabId)
    }

    /// `<base>/plugins/<pluginId>/ui/index.html?tab=<tabId>`, both encodeURIComponent'd; one
    /// trailing slash on `baseUrl` is dropped.
    public static func pluginUiUrl(baseUrl: String, pluginId: String, tabId: String) -> String {
        let base = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        return "\(base)/plugins/\(URIComponent.encode(pluginId))/ui/index.html?tab=\(URIComponent.encode(tabId))"
    }

    // MARK: Live events

    /// `ws://…/ws?token=…` (`https` → `wss`).
    public var socketUrl: String {
        let ws = baseUrl.hasPrefix("http") ? "ws" + baseUrl.dropFirst(4) : baseUrl
        return "\(ws)/ws?token=\(URIComponent.encode(token))"
    }

    /// Open the live event stream. It reconnects automatically until `close()` is called.
    public func connect(
        factory: @escaping WebSocketFactory = URLSessionWebSocketConnection.factory,
        sleep: @escaping HarnessSocket.Sleep = { try await Task.sleep(for: $0) }
    ) -> HarnessSocket {
        HarnessSocket(url: socketUrl, factory: factory, sleep: sleep)
    }
}
