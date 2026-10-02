import Foundation

// Port of mobile/src/lib/details.ts: ticket details the board and ticket screens need but the
// snapshot doesn't carry. Done tickets page in, so a dependency, a dependent, a conductor's done
// children or the ticket a deep link opens may not be loaded. The selectors say what's missing
// (unresolvedKeys, conductorsNeedingChildren); this fetches each once per snapshot, a few at a
// time, and records 404s so they aren't asked for again.

@MainActor
public final class DetailFetcher {
    public static let defaultConcurrency = 4

    private let client: any DetailClient
    private let dispatch: @MainActor (BoardAction) -> Void
    private let concurrency: Int
    /// Remote IDs, which BoardState doesn't keep: a loaded ticket's relatedTickets (by ticket id)…
    private let onRelated: (@MainActor (String, [RelatedTicket]) -> Void)?
    /// …and the tickets a remote-only key points to (by the upper-cased key asked for; [] once it
    /// resolves to a ticket or 404s with no matches).
    private let onRemoteKey: (@MainActor (String, [RelatedTicket]) -> Void)?

    private var inflight: [String: Task<TicketDetail, any Error>] = [:]
    /// Keys fetched (or failed) since the last snapshot
    private var done: Set<String> = []
    private var queue: [String] = []
    private var running = 0

    public init(
        client: any DetailClient,
        dispatch: @escaping @MainActor (BoardAction) -> Void,
        concurrency: Int = DetailFetcher.defaultConcurrency,
        onRelated: (@MainActor (String, [RelatedTicket]) -> Void)? = nil,
        onRemoteKey: (@MainActor (String, [RelatedTicket]) -> Void)? = nil
    ) {
        self.client = client
        self.dispatch = dispatch
        self.concurrency = concurrency
        self.onRelated = onRelated
        self.onRemoteKey = onRemoteKey
    }

    /// A snapshot reset aliases, children and missing keys: everything may be asked for again.
    public func reset() {
        done.removeAll()
        queue.removeAll()
    }

    /// The tickets a remote-only key points to, from a getTicket 404 (lib/related.ts remoteMatchesOf).
    public static func remoteMatches(_ error: any Error) -> RemoteKeyMatches? {
        guard let e = error as? HarnessAPIError, e.status == 404, let data = e.data,
              let bytes = try? JSONEncoder().encode(data),
              let m = try? JSONDecoder().decode(RemoteKeyMatches.self, from: bytes), !m.relatedTickets.isEmpty
        else { return nil }
        return m
    }

    /// One ticket's detail, merged into the store. Concurrent asks for the same key share a
    /// request. The task throws on failure (a 404 is also recorded as a missing key).
    public func request(_ key: String) -> Task<TicketDetail, any Error> {
        let k = JSString.upper(key)
        if let existing = inflight[k] { return existing }
        let client = client
        let task = Task { @MainActor in
            defer {
                self.inflight[k] = nil
                self.done.insert(k)
            }
            do {
                let detail = try await client.getTicket(key)
                self.dispatch(.detail(detail, requestedKey: key))
                // Older services don't send relatedTickets: leave what's known alone.
                if let related = detail.relatedTickets { self.onRelated?(detail.ticket.id, related) }
                self.onRemoteKey?(k, [])
                return detail
            } catch {
                if let e = error as? HarnessAPIError, e.status == 404 {
                    self.dispatch(.missingKeys([key]))
                    self.onRemoteKey?(k, Self.remoteMatches(error)?.relatedTickets ?? [])
                }
                throw error
            }
        }
        inflight[k] = task
        return task
    }

    /// `load(key)`: the detail, awaited.
    public func load(_ key: String) async throws -> TicketDetail {
        try await request(key).value
    }

    /// What the state says is missing (plus `extra` keys a screen is showing), not yet asked for.
    public func wanted(_ state: BoardState, extra: [String] = []) -> [String] {
        let keys = state.unresolvedKeys(extra) + state.conductorsNeedingChildren().map(\.key)
        var out: [String] = []
        var seen: Set<String> = []
        for key in keys {
            let k = JSString.upper(key)
            if seen.contains(k) || done.contains(k) || inflight[k] != nil || queue.contains(k) { continue }
            seen.insert(k)
            out.append(key)
        }
        return out
    }

    /// Fetch whatever is wanted, at most `concurrency` at a time.
    public func sync(_ state: BoardState, extra: [String] = []) {
        for key in wanted(state, extra: extra) { queue.append(JSString.upper(key)) }
        pump()
    }

    private func pump() {
        while running < concurrency, !queue.isEmpty {
            let key = queue.removeFirst()
            if done.contains(key) || inflight[key] != nil { continue }
            running += 1
            let task = request(key)
            Task { @MainActor in
                _ = try? await task.value
                self.running -= 1
                self.pump()
            }
        }
    }
}
