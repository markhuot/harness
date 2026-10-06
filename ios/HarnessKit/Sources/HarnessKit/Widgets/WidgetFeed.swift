import Foundation

// What the home screen and desktop widgets draw (ARCHITECTURE.md § Widgets). The widget
// extensions (ios/Widgets) fetch it from the service themselves, and the apps write the last one
// they saw into the App Group container so a widget still has something to show when the service
// can't be reached.

/// One ticket as a widget draws it: everything resolved, so the widget needs no board state.
public struct WidgetTicket: Codable, Sendable, Equatable, Identifiable {
    /// The local key: what a tap opens (harness://ticket/<key>).
    public var key: String
    /// The remote ID when the ticket has one, else the key (`Keys.displayKey`).
    public var displayKey: String
    public var title: String
    public var status: TicketStatus
    /// The project's key ("HARNESS"); nil when the project wasn't in the feed.
    public var projectKey: String?
    /// The project's stored color (a preset id or "#rrggbb"), drawn with `ProjectKeyColors`.
    public var projectColor: String?
    /// An agent run is queued or running for it, or for one of its children.
    public var working: Bool
    /// The tool a pending approval asks for ("Bash"), shortened like the board card's.
    public var approvalTool: String?
    /// Why it's blocked, when it is and no approval is pending.
    public var blockedReason: String?
    /// The latest Activity line, as plain text.
    public var news: String?
    public var updatedAt: Timestamp

    public var id: String { key }

    public init(
        key: String, displayKey: String, title: String, status: TicketStatus, projectKey: String? = nil, projectColor: String? = nil,
        working: Bool = false, approvalTool: String? = nil, blockedReason: String? = nil, news: String? = nil, updatedAt: Timestamp
    ) {
        self.key = key
        self.displayKey = displayKey
        self.title = title
        self.status = status
        self.projectKey = projectKey
        self.projectColor = projectColor
        self.working = working
        self.approvalTool = approvalTool
        self.blockedReason = blockedReason
        self.news = news
        self.updatedAt = updatedAt
    }
}

/// The active tickets at one moment, most recent first.
public struct WidgetSnapshot: Codable, Sendable, Equatable {
    public var tickets: [WidgetTicket]
    /// Every active ticket, including those past `tickets`' limit ("+4 more").
    public var activeCount: Int
    public var generatedAt: Timestamp

    public init(tickets: [WidgetTicket], activeCount: Int, generatedAt: Timestamp) {
        self.tickets = tickets
        self.activeCount = activeCount
        self.generatedAt = generatedAt
    }

    public static let empty = WidgetSnapshot(tickets: [], activeCount: 0, generatedAt: 0)

    /// Ticket keys, statuses and what they say, without the time it was taken: two snapshots with the
    /// same content needn't reload a widget.
    public func sameContent(as other: WidgetSnapshot) -> Bool {
        tickets == other.tickets && activeCount == other.activeCount
    }
}

public enum WidgetFeed {
    /// How many tickets a snapshot keeps: enough for the large compact list.
    public static let limit = 10
    /// How many tickets get their latest Activity line fetched (the medium widget shows one, the
    /// large one up to three).
    public static let newsLimit = 3
    /// The statuses a live fetch asks for: everything that can be active.
    public static let fetchStatuses: [TicketStatus] = [.planning, .inProgress, .blocked, .review]

    /// A ticket the widgets show: not a draft, not done, and either being worked (in progress,
    /// blocked, in review) or busy with a run (a planning ticket drafting its plan).
    public static func isActive(_ t: Ticket) -> Bool {
        if t.draft == true { return false }
        switch t.status {
        case .inProgress, .blocked, .review: return true
        case .planning: return t.busy
        case .done, .unknown: return false
        }
    }

    /// The active tickets, most recently updated first (ties by key, so the order is stable).
    public static func active(_ tickets: some Sequence<Ticket>) -> [Ticket] {
        tickets.filter(isActive).sorted {
            $0.updatedAt != $1.updatedAt ? $0.updatedAt > $1.updatedAt : JSString.less($0.key, $1.key)
        }
    }

    /// The snapshot for `tickets` (any set: the board's, or a fetch's). `news` gives a ticket's
    /// latest Activity entry when it's known.
    public static func snapshot(
        tickets: some Collection<Ticket>, projects: [String: Project], news: (Ticket) -> ActivityEntry? = { _ in nil },
        now: Timestamp, limit: Int = limit
    ) -> WidgetSnapshot {
        let list = active(tickets)
        let busyParents = Set(tickets.filter(\.busy).compactMap(\.parentId))
        let shown = list.prefix(limit).map { t in
            widgetTicket(t, project: projects[t.projectId], working: t.busy || busyParents.contains(t.id), news: news(t))
        }
        return WidgetSnapshot(tickets: Array(shown), activeCount: list.count, generatedAt: now)
    }

    static func widgetTicket(_ t: Ticket, project: Project?, working: Bool, news: ActivityEntry?) -> WidgetTicket {
        let blocked = t.status == .blocked && t.pendingApproval == nil ? t.blockedReason.flatMap { $0.isEmpty ? nil : $0 } : nil
        let line = news.map { Markdown.plainText($0.body) }.flatMap { $0.isEmpty ? nil : $0 }
        return WidgetTicket(
            key: t.key, displayKey: Keys.displayKey(t), title: BoardScreenRules.cardTitle(t), status: t.status,
            projectKey: project?.key, projectColor: project?.color, working: working,
            approvalTool: t.pendingApproval.map { Format.shortToolName($0.toolName) }, blockedReason: blocked, news: line,
            updatedAt: t.updatedAt
        )
    }

    /// Fetches a snapshot from the service: the tickets that can be active, the projects, and the
    /// latest Activity line of the first `newsLimit` tickets (a failed Activity fetch only drops
    /// that line).
    public static func fetch(_ client: HarnessClient, now: Timestamp, limit: Int = limit) async throws -> WidgetSnapshot {
        async let ticketsReq = client.listTickets(status: fetchStatuses)
        async let projectsReq = client.listProjects()
        let (tickets, projects) = try await (ticketsReq, projectsReq)
        let byId = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let heads = active(tickets).prefix(min(limit, newsLimit))
        let news = await withTaskGroup(of: (String, ActivityEntry?).self) { group in
            for t in heads {
                group.addTask {
                    let entries = (try? await client.listActivity(t.key)) ?? []
                    return (t.id, entries.last { ActivityRows.newsKinds.contains($0.kind) })
                }
            }
            var out: [String: ActivityEntry] = [:]
            for await (id, entry) in group { if let entry { out[id] = entry } }
            return out
        }
        return snapshot(tickets: tickets, projects: byId, news: { news[$0.id] }, now: now, limit: limit)
    }

    /// harness://ticket/<key>: what tapping a ticket opens, in either app.
    public static func ticketURL(_ key: String) -> URL? {
        URL(string: "\(DeepLink.scheme)://ticket/\(URIComponent.encode(key))")
    }

    /// harness://board, for a tap anywhere else on the widget.
    public static let boardURL = URL(string: "\(DeepLink.scheme)://board")!
}
