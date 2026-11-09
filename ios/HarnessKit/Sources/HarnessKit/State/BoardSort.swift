import Foundation

// Port of shared/src/state/boardSort.ts: how the cards in a live column are sorted ("Sort by"),
// and the "Group by project" sections on a board that spans projects (All projects, a group).
// The Done column keeps its newest-completed order (it pages from the service) and only groups.

public enum BoardSort: String, Codable, Sendable, CaseIterable {
    case recent, created, title

    /// BOARD_SORT_DEFAULT
    public static let defaultSort: BoardSort = .recent

    public var label: String {
        switch self {
        case .recent: "Recent activity"
        case .created: "Created"
        case .title: "Title"
        }
    }

    /// The comparator for a live column (a strict "comes before"); ties fall back to creation order.
    /// `activeAt` is BoardState.activeAt (live run and transcript times by session).
    public func comparator(_ activeAt: [String: Timestamp] = [:]) -> (Ticket, Ticket) -> Bool {
        switch self {
        case .recent:
            return { a, b in
                let la = BoardOrder.lastActive(a, activeAt), lb = BoardOrder.lastActive(b, activeAt)
                return la != lb ? la > lb : BoardOrder.created(a, b)
            }
        case .title:
            return { a, b in
                let c = BoardOrder.title(a).compare(BoardOrder.title(b), options: [.caseInsensitive, .numeric, .diacriticInsensitive])
                return c != .orderedSame ? c == .orderedAscending : BoardOrder.created(a, b)
            }
        case .created:
            return BoardOrder.created
        }
    }
}

public enum BoardOrder {
    /// When the ticket's agent last did anything: Ticket.lastActiveAt (updatedAt from an older
    /// service), or a newer run or transcript event heard live since (BoardState.activeAt).
    public static func lastActive(_ t: Ticket, _ activeAt: [String: Timestamp] = [:]) -> Timestamp {
        max(t.lastActiveAt ?? t.updatedAt, activeAt[t.sessionId] ?? 0)
    }

    /// Creation order: position, then age, then id (the order before sorting existed).
    static func created(_ a: Ticket, _ b: Ticket) -> Bool { Paging.boardOrder(a, b) }

    static func title(_ t: Ticket) -> String {
        let trimmed = JSCompat.trim(t.title)
        return trimmed.isEmpty ? "Untitled" : trimmed
    }
}

/// One project's cards in a grouped column.
public struct ProjectSection: Sendable, Equatable, Identifiable {
    /// Nil for tickets whose project isn't loaded (they come last).
    public var project: Project?
    public var projectId: String
    public var tickets: [Ticket]
    public var id: String { projectId }
}

extension BoardOrder {
    /// A column's tickets in sections by project: projects by name (as the sidebar lists them),
    /// each section keeping the column's order. Empty projects get no section.
    public static func sectionsByProject(_ projects: [String: Project], _ tickets: [Ticket]) -> [ProjectSection] {
        var order: [String] = []
        var byId: [String: [Ticket]] = [:]
        for t in tickets {
            if byId[t.projectId] == nil { order.append(t.projectId) }
            byId[t.projectId, default: []].append(t)
        }
        return order
            .map { ProjectSection(project: projects[$0], projectId: $0, tickets: byId[$0] ?? []) }
            .sorted { a, b in
                guard let pa = a.project, let pb = b.project else {
                    if a.project != nil { return true }
                    if b.project != nil { return false }
                    return JSString.less(a.projectId, b.projectId)
                }
                let c = BoardState.localeCompare(pa.name, pb.name)
                return c != .orderedSame ? c == .orderedAscending : JSString.less(a.projectId, b.projectId)
            }
    }
}
