import Foundation

// The slices of HarnessClient the board's stateful pieces call, as protocols so tests can fake
// the service. The requirements have HarnessClient's exact signatures, so it conforms as is.

/// What BoardLoader asks for: Done pages and server-side search.
public protocol LoaderClient: Sendable {
    func ticketPage(status: TicketStatus, projectId: String?, q: String?, limit: Int?, cursor: String?) async throws -> TicketPage
    func searchTickets(q: String, projectId: String?, limit: Int?, cursor: String?) async throws -> TicketPage
}

/// What DetailFetcher asks for: one ticket's detail by key.
public protocol DetailClient: Sendable {
    func getTicket(_ key: String) async throws -> TicketDetail
}

/// Everything BoardStore needs for snapshots and backfills.
public protocol BoardClient: LoaderClient, DetailClient {
    func listProjects() async throws -> [Project]
    func listTickets(projectId: String?, status: [TicketStatus]) async throws -> [Ticket]
    func listSessions(kind: SessionKind?) async throws -> [Session]
    func listWatchers() async throws -> [Watcher]
    func getSettings() async throws -> PublicSettings
    func listDrivers() async throws -> [DriverInfo]
    func listSummaries(_ key: String) async throws -> [Summary]
}

extension HarnessClient: BoardClient {}

/// `e instanceof Error ? e.message : String(e)`: the message a failed request shows.
func errorMessage(_ error: any Error) -> String {
    if let e = error as? HarnessAPIError { return e.message }
    if let e = error as? LocalizedError, let d = e.errorDescription { return d }
    return String(describing: error)
}
