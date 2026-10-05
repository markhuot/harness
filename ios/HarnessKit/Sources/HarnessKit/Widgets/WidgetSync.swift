import Foundation

/// What the iPhone/iPad app hands its widgets as the board changes: the active server (WidgetHost)
/// and a snapshot of the board's active tickets. The app target's WidgetSync writes them into the
/// App Group and reloads the widgets; this decides when, so a board that changes in ways the
/// widgets don't show (a transcript line, a done ticket) never reloads them.
public struct WidgetSyncState: Equatable, Sendable {
    public var host: WidgetHost?
    public var snapshot: WidgetSnapshot?

    public init(host: WidgetHost? = nil, snapshot: WidgetSnapshot? = nil) {
        self.host = host
        self.snapshot = snapshot
    }

    /// The widgets' view of the app now. No server: no host and no snapshot (forgetting the last
    /// server clears the widgets). A server whose board hasn't loaded yet keeps the snapshot already
    /// saved (nil here means "leave it"), so a cold start doesn't flash "Nothing active".
    public static func current(active: ActiveServer?, prefs: Prefs, board: BoardState?, now: Timestamp) -> WidgetSyncState {
        guard let active else { return WidgetSyncState() }
        let host = WidgetHost(baseUrl: active.baseUrl, token: active.token, name: active.name, lightTheme: prefs.lightTheme, darkTheme: prefs.darkTheme)
        guard let board, board.ready else { return WidgetSyncState(host: host, snapshot: nil) }
        let snapshot = WidgetFeed.snapshot(
            tickets: board.tickets.values, projects: board.projects,
            news: { board.latestActivity($0.sessionId, kinds: ActivityRows.newsKinds) }, now: now
        )
        return WidgetSyncState(host: host, snapshot: snapshot)
    }

    /// What changed from `previous` (what was last written) to `self`.
    public struct Plan: Equatable, Sendable {
        /// Write the host file (`.some(nil)` removes it).
        public var host: WidgetHost??
        /// Write the snapshot file (`.some(nil)` removes it).
        public var snapshot: WidgetSnapshot??
        /// Reload the widget timelines.
        public var reload: Bool

        public static let nothing = Plan(host: .none, snapshot: .none, reload: false)
    }

    public func plan(from previous: WidgetSyncState?) -> Plan {
        var plan = Plan.nothing
        if previous == nil || previous?.host != host {
            plan.host = .some(host)
            plan.reload = true
        }
        if host == nil {
            // Unpaired: clear the snapshot too, once.
            if previous == nil || previous?.snapshot != nil || previous?.host != nil { plan.snapshot = .some(nil) }
        } else if let snapshot, previous?.snapshot.map({ snapshot.sameContent(as: $0) }) != true {
            plan.snapshot = .some(snapshot)
            plan.reload = true
        }
        return plan
    }

    /// What's written once `plan` is applied: a snapshot left alone stays what it was.
    public func written(after previous: WidgetSyncState?) -> WidgetSyncState {
        WidgetSyncState(host: host, snapshot: host == nil ? nil : (snapshot ?? previous?.snapshot))
    }
}
