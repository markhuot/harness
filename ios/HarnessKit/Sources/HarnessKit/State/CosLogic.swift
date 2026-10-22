import Foundation

// Chief of staff presentation logic: the Swift twin of shared/src/state/cos.ts and the pure parts of
// shared/src/cos.ts, so the iPhone, iPad and Mac count and label the same way.

/// What the CoS keeps in the store: the chiefs, the Inbox events and chat entries loaded so far,
/// and the badge. Held beside the reducer's state (the TS reducer's slices have no Swift twin).
public struct CosState: Equatable, Sendable {
    public var chiefs: [String: Cos] = [:]
    public var events: [String: CosEvent] = [:]
    public var chat: [String: [CosChatEntry]] = [:]
    public var badge: CosBadge?

    public init(chiefs: [String: Cos] = [:], events: [String: CosEvent] = [:], chat: [String: [CosChatEntry]] = [:], badge: CosBadge? = nil) {
        self.chiefs = chiefs
        self.events = events
        self.chat = chat
        self.badge = badge
    }

    /// One bus event: an upserted row, the badge, or a live chat entry.
    public mutating func apply(_ event: CosBusEvent) {
        switch event {
        case let .eventUpserted(e): events[e.id] = e
        case let .badge(b): badge = b
        case let .transcriptAppended(cosId, entry): chat[cosId] = CosLogic.mergeChat(chat[cosId] ?? [], [entry])
        }
    }

    public mutating func setChiefs(_ list: [Cos]) {
        chiefs = Dictionary(list.map { ($0.ticketId, $0) }, uniquingKeysWith: { _, b in b })
    }

    public mutating func mergeEvents(_ page: [CosEvent]) {
        for e in page { events[e.id] = e }
    }

    public mutating func mergeChat(_ cosId: String, _ page: [CosChatEntry]) {
        chat[cosId] = CosLogic.mergeChat(chat[cosId] ?? [], page)
    }

    /// The chief of a scope ("all" or "group:<id>"), when it exists yet.
    public func chief(scope: String) -> Cos? {
        chiefs.values.first { $0.scope == scope }
    }

    /// The rows a chief's Inbox shows: its own events and the unassigned ones, newest first. Rows its
    /// own rules dropped (filtered) stay out.
    public func inbox(_ cosId: String) -> [CosEvent] {
        CosLogic.mergeEvents([], events.values.filter { ($0.cosId == cosId || $0.cosId == nil) && $0.verdict != .filtered })
    }
}

/// A chief's pane has these two tabs and no others (no Spec, Activity or Tickets).
public enum CosTab: String, CaseIterable, Sendable, Hashable {
    case chat, inbox

    public var label: String { self == .chat ? "Chat" : "Inbox" }
}

/// What an Inbox row says happened to the event, in a word.
public enum CosInboxState: String, Sendable {
    case waiting, ignored, escalated, handling, handled, filtered

    public var label: String {
        switch self {
        case .waiting: "Waiting for a verdict"
        case .ignored: "Ignored"
        case .escalated: "Escalated"
        case .handling: "Handling"
        case .handled: "Handled"
        case .filtered: "Filtered"
        }
    }
}

/// A project's value for a CoS switch: inherit the app's, or its own on or off.
public enum CosTriState: String, CaseIterable, Sendable, Hashable {
    case inherit, on, off

    public init(_ value: Patch<Bool>) {
        switch value {
        case .value(true): self = .on
        case .value(false): self = .off
        default: self = .inherit
        }
    }

    /// The `Project.cosEnabled` / `cosCanUnblock` a choice saves: `.null` clears the override.
    public var patch: Patch<Bool> {
        switch self {
        case .on: .value(true)
        case .off: .value(false)
        case .inherit: .null
        }
    }
}

public enum CosSettings {
    /// COS_SETTING_DEFAULTS
    public static let defaultEnabled = true
    public static let defaultCanUnblock = false

    /// A CoS setting for one project: the project's own value, else the app's, else the default.
    public static func resolve(project: Patch<Bool>, app: Bool?, default fallback: Bool) -> Bool {
        project.optional ?? app ?? fallback
    }

    public static func enabled(_ settings: PublicSettings?) -> Bool { settings?.cosEnabled ?? defaultEnabled }
    public static func canUnblock(_ settings: PublicSettings?) -> Bool { settings?.cosCanUnblock ?? defaultCanUnblock }

    /// What "Inherit" resolves to, for its label ("Inherit (on)").
    public static func inheritedLabel(_ app: Bool) -> String { "Inherit (\(app ? "on" : "off"))" }

    public static func label(_ choice: CosTriState, inherited: Bool) -> String {
        switch choice {
        case .inherit: inheritedLabel(inherited)
        case .on: "On"
        case .off: "Off"
        }
    }
}

public enum CosLogic {
    /// "all" or "group:<id>"
    public static func scopeKey(groupId: String?) -> String {
        guard let groupId, !groupId.isEmpty else { return "all" }
        return "group:\(groupId)"
    }

    /// The scope whose chief a board shows: All projects → all; a group's board → that group; a
    /// project's board → its group's chief, else All. `filter` is `BoardState.boardFilter`'s result.
    public static func boardScope(filter: String?, projects: [String: Project]) -> String {
        guard let filter else { return "all" }
        if let group = Paging.scopeGroup(filter) { return scopeKey(groupId: group) }
        return scopeKey(groupId: projects[filter]?.groupId)
    }

    /// What a chief's header is called: "All projects", or its group's name.
    public static func title(scope: String, groupName: String?) -> String {
        scope == "all" ? "All projects" : (groupName ?? "Group")
    }

    /// Events awaiting a verdict or being handled by one chief (0 when the badge hasn't loaded).
    public static func badgeCount(_ badge: CosBadge?, cosId: String?) -> Int {
        guard let cosId else { return 0 }
        return badge?.byCos[cosId] ?? 0
    }

    /// The count to show on a button: nothing at 0, "99+" past 99.
    public static func badgeText(_ count: Int) -> String? {
        count <= 0 ? nil : count > 99 ? "99+" : "\(count)"
    }

    /// Statuses that count toward the badge (an event somebody still has to see to).
    public static let openStatuses: [CosEventStatus] = [.pending, .triaging, .escalated, .handling]

    /// Open events of the loaded ones: the client-side twin of the service's badge.
    public static func openEventCount(_ events: [CosEvent], cosId: String) -> Int {
        events.filter { $0.cosId == cosId && openStatuses.contains($0.status) }.count
    }

    public static func inboxState(status: CosEventStatus, verdict: CosEventVerdict) -> CosInboxState {
        if verdict == .filtered { return .filtered }
        switch status {
        case .pending, .triaging: return .waiting
        case .ignored: return .ignored
        case .escalated: return .escalated
        case .handling: return .handling
        case .handled: return .handled
        case .unknown: return .waiting
        }
    }

    public static func inboxState(_ e: CosEvent) -> CosInboxState { inboxState(status: e.status, verdict: e.verdict) }

    /// Ignored events (and only those) can be escalated by hand.
    public static func canEscalate(_ e: CosEvent) -> Bool { e.status == .ignored && e.verdict != .filtered }

    /// The line a row says about the verdict: the reason for an ignored or escalated one, that the
    /// chief dealt with a handled one (the wire carries only the handling run's id), else nil.
    public static func verdictLine(_ e: CosEvent) -> String? {
        switch inboxState(e) {
        case .ignored, .escalated: e.reason.flatMap { $0.isEmpty ? nil : $0 }
        case .handled: "The chief of staff dealt with it"
        default: nil
        }
    }

    public static func sourceLabel(_ s: CosEventSource) -> String {
        switch s {
        case .activity: "Ticket"
        case .watcher: "Watcher"
        case .schedule: "Schedule"
        case .unknown: "Event"
        }
    }

    /// A chat's entries, oldest first, with `incoming` merged in. An id seen twice (a page loaded
    /// after the same entry arrived live, or the reverse) is kept once, the incoming copy winning.
    public static func mergeChat(_ existing: [CosChatEntry], _ incoming: [CosChatEntry]) -> [CosChatEntry] {
        var byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        var changed = false
        for e in incoming where byId[e.id] != e {
            byId[e.id] = e
            changed = true
        }
        guard changed else { return existing }
        return byId.values.sorted { $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : JSString.less($0.id, $1.id) }
    }

    /// The Inbox's rows: newest first, each id once.
    public static func mergeEvents(_ existing: [CosEvent], _ incoming: [CosEvent]) -> [CosEvent] {
        var byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        for e in incoming { byId[e.id] = e }
        return byId.values.sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : JSString.less($1.id, $0.id) }
    }

    /// One thing a chat shows: a message, a short line for what the chief did, or a ticket card.
    public enum ChatRow: Equatable, Sendable, Identifiable {
        case message(id: String, fromHuman: Bool, text: String)
        /// "Looked at 3 events: ignored 3 routine moves"; a wake is one line.
        case line(id: String, text: String)
        case ticket(id: String, key: String, title: String, status: String, moved: Bool)

        public var id: String {
            switch self {
            case let .message(id, _, _), let .line(id, _), let .ticket(id, _, _, _, _): id
            }
        }
    }

    /// The rows of a chat, oldest first. Entries this build doesn't know are left out.
    public static func rows(_ entries: [CosChatEntry]) -> [ChatRow] {
        entries.compactMap { e in
            switch e {
            case let .message(id, _, _, role, text): .message(id: id, fromHuman: role == "user", text: text)
            case let .ticketCreated(id, _, _, key, title, status): .ticket(id: id, key: key, title: title, status: status, moved: false)
            case let .ticketMoved(id, _, _, key, title, _, to): .ticket(id: id, key: key, title: title, status: to, moved: true)
            case let .eventBatch(id, _, _, _, eventIds, digest): .line(id: id, text: wakeLine(count: eventIds.count, digest: digest))
            case .unknown: nil
            }
        }
    }

    /// "in_progress" → "In progress": a ticket status the way a card says it.
    public static func statusLabel(_ raw: String) -> String {
        let words = raw.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// "Woke for 3 events: ignored 3 routine moves"
    public static func wakeLine(count: Int, digest: String) -> String {
        let head = "Woke for \(count) event\(count == 1 ? "" : "s")"
        return digest.isEmpty ? head : "\(head): \(digest)"
    }

    /// Whether a chat scroller is near enough its top to ask for the next older page.
    public static func nearTop(_ offset: Double, threshold: Double = 80) -> Bool { offset <= threshold }

    /// Where a scroller sits after older entries were prepended above what it showed: the same
    /// content stays under the same pixel.
    public static func anchoredOffset(beforeOffset: Double, beforeHeight: Double, height: Double) -> Double {
        max(0, beforeOffset + (height - beforeHeight))
    }
}
