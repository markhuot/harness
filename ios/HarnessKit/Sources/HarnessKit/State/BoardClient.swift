import Foundation

// The slices of HarnessClient the board's stateful pieces call, as protocols so tests can fake
// the service. The requirements have HarnessClient's exact signatures, so it conforms as is.

/// What BoardLoader asks for: Done pages and server-side search.
public protocol LoaderClient: Sendable {
    func ticketPage(status: TicketStatus, projectId: String?, groupId: String?, q: String?, limit: Int?, cursor: String?) async throws -> TicketPage
    func searchTickets(q: String, projectId: String?, groupId: String?, limit: Int?, cursor: String?) async throws -> TicketPage
}

/// What DetailFetcher asks for: one ticket's detail by key.
public protocol DetailClient: Sendable {
    func getTicket(_ key: String) async throws -> TicketDetail
}

/// Everything BoardStore needs for snapshots and backfills.
public protocol BoardClient: LoaderClient, DetailClient {
    func health() async throws -> Health
    func listProjects() async throws -> [Project]
    func listTickets(projectId: String?, status: [TicketStatus]) async throws -> [Ticket]
    func listSessions(kind: SessionKind?) async throws -> [Session]
    func listWatchers() async throws -> [Watcher]
    func getSettings() async throws -> PublicSettings
    func listDrivers() async throws -> [DriverInfo]
    func listActivity(_ key: String) async throws -> [ActivityEntry]
    /// The plan-usage gauges' readings; a client without them throws and the store keeps no report.
    func getUsage() async throws -> PlanUsageReport
    /// The service's terminals; `refresh` looks up each one's cwd and process first (a palette opening).
    func listTerminals(refresh: Bool) async throws -> [TerminalInfo]
    func createTerminal(_ body: CreateTerminalBody) async throws -> TerminalInfo
    func closeTerminal(_ id: String) async throws
    /// The chiefs of staff and their Inbox badge; a client without them throws and the store keeps none.
    func listCos() async throws -> [Cos]
    func cosBadge() async throws -> CosBadge
}

extension BoardClient {
    public func getUsage() async throws -> PlanUsageReport { throw URLError(.unsupportedURL) }
    public func listTerminals(refresh: Bool) async throws -> [TerminalInfo] { [] }
    public func createTerminal(_ body: CreateTerminalBody) async throws -> TerminalInfo { throw URLError(.unsupportedURL) }
    public func closeTerminal(_ id: String) async throws { throw URLError(.unsupportedURL) }
    public func listCos() async throws -> [Cos] { [] }
    public func cosBadge() async throws -> CosBadge { throw URLError(.unsupportedURL) }
}

extension HarnessClient: BoardClient {}
