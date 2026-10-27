import Foundation

// Chief of staff presentation logic: the Swift twin of shared/src/state/cos.ts and the pure parts of
// shared/src/cos.ts, so the iPhone, iPad and Mac count and label the same way.

/// What the CoS keeps in the store: the chiefs, the Inbox events and chat entries loaded so far,
/// and the badge. Held beside the reducer's state (the TS reducer's slices have no Swift twin).
public struct CosState: Equatable, Sendable {
    public var chiefs: [String: Cos] = [:]
    public var events: [String: TicketEvent] = [:]
    public var chat: [String: [CosChatEntry]] = [:]
    public var badge: CosBadge?

    public init(chiefs: [String: Cos] = [:], events: [String: TicketEvent] = [:], chat: [String: [CosChatEntry]] = [:], badge: CosBadge? = nil) {
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

    /// The chief's own ticket upserted (it stays out of the board's tickets): its message draft rides
    /// on the chief, for the composer.
    public mutating func applyChiefTicket(_ t: Ticket) {
        guard t.kind == .cos, var chief = chiefs[t.id] else { return }
        let draft: Patch<MessageDraft> = Patch(t.messageDraft.optional)
        guard chief.messageDraft.optional != draft.optional || chief.pendingApproval != t.pendingApproval else { return }
        chief.messageDraft = draft
        chief.pendingApproval = t.pendingApproval
        chiefs[t.id] = chief
    }

    public mutating func mergeEvents(_ page: [TicketEvent]) {
        for e in page { events[e.id] = e }
    }

    public mutating func mergeChat(_ cosId: String, _ page: [CosChatEntry]) {
        chat[cosId] = CosLogic.mergeChat(chat[cosId] ?? [], page)
    }

    /// Merges a chat's newest page after a (re)load. When older entries remain (`hasOlder`) and the page
    /// shares nothing with what is loaded, entries arrived in between that no page covers: what was
    /// loaded is dropped (live entries newer than the page stay) so the page's cursor reaches all of
    /// it. Returns true when it did.
    @discardableResult
    public mutating func loadNewestChat(_ cosId: String, _ page: [CosChatEntry], hasOlder: Bool) -> Bool {
        let existing = chat[cosId] ?? []
        let ids = Set(existing.map(\.id))
        let hole = hasOlder && !existing.isEmpty && !page.contains { ids.contains($0.id) }
        if hole {
            let newest = page.map(\.createdAt).max() ?? 0
            chat[cosId] = existing.filter { $0.createdAt > newest }
        }
        mergeChat(cosId, page)
        return hole
    }

    /// The events twin of `loadNewestChat`: drops the ticket's loaded rows (and, for a chief's Inbox,
    /// the unassigned ones) when the newest page leaves a hole above them.
    @discardableResult
    public mutating func loadNewestEvents(_ ticketId: String, _ page: [TicketEvent], hasOlder: Bool, chief: Bool = true) -> Bool {
        let own = events.values.filter { $0.targetId == ticketId || (chief && $0.targetId == nil) }
        let hole = hasOlder && !own.isEmpty && !page.contains { events[$0.id] != nil }
        if hole {
            let newest = page.map(\.createdAt).max() ?? 0
            for e in own where e.createdAt <= newest { events[e.id] = nil }
        }
        mergeEvents(page)
        return hole
    }

    /// The chief of a scope ("all" or "group:<id>"), when it exists yet.
    public func chief(scope: String) -> Cos? {
        chiefs.values.first { $0.scope == scope }
    }

    /// The rows a chief's Inbox shows: its own events and the unassigned ones, newest first. Rows its
    /// own rules dropped (filtered) stay out, except a reminder: it went to the person, so it shows.
    public func inbox(_ cosId: String) -> [TicketEvent] { rows(ticketId: cosId, chief: true) }

    /// The rows of an events list, newest first: a chief's Inbox (`chief`) is its own events and the
    /// unassigned ones; any other ticket's Events tab is the events aimed at it. Rows a coded rule
    /// dropped (filtered) stay out of both, except a reminder in the Inbox.
    public func rows(ticketId: String, chief: Bool) -> [TicketEvent] {
        CosLogic.mergeEvents([], events.values.filter {
            ($0.targetId == ticketId || (chief && $0.targetId == nil)) && ($0.verdict != .filtered || (chief && $0.sourceKind == .schedule))
        })
    }
}

/// A chief's pane has these three tabs and no others (no Spec, Activity or Tickets).
public enum CosTab: String, CaseIterable, Sendable, Hashable {
    case chat, inbox, listeners

    public var label: String {
        switch self {
        case .chat: "Chat"
        case .inbox: "Inbox"
        case .listeners: "Listeners"
        }
    }
}

/// What an Inbox row says happened to the event, in a word.
public enum CosInboxState: String, Sendable {
    case waiting, ignored, escalated, handling, acted, noAction, needsUser, reviewed, filtered

    /// What the row says: in a chief's Inbox (`chief`) a verdict; in a ticket's Events tab, where no
    /// chief judges the rows, how far delivery has come.
    public func label(chief: Bool) -> String {
        if chief { return label }
        switch self {
        case .waiting: return "Waiting to be delivered"
        case .escalated: return "Queued for the ticket"
        case .handling: return "In the ticket's run"
        case .acted, .noAction, .needsUser, .reviewed: return "Delivered"
        case .ignored, .filtered: return label
        }
    }

    public var label: String {
        switch self {
        case .waiting: "Waiting for a verdict"
        case .ignored: "Ignored"
        case .escalated: "Escalated"
        case .handling: "Handling"
        case .acted: "Acted"
        case .noAction: "No action needed"
        case .needsUser: "Needs you"
        case .reviewed: "Reviewed, no outcome recorded"
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

    /// The `Project.cosEnabled` a choice saves: `.null` clears the override.
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
    /// COS_STATUS_DEFAULTS: no column, so a person opts in to what their chief handles
    public static let defaultStatuses: [TicketStatus] = []

    public static func enabled(_ settings: PublicSettings?) -> Bool { settings?.cosEnabled ?? defaultEnabled }
    /// resolveCosStatuses for the app (no project override)
    public static func statuses(_ settings: PublicSettings?) -> [TicketStatus] { settings?.cosStatuses ?? defaultStatuses }

    /// resolveCosStatuses: the project's own columns, else the app's.
    public static func statuses(_ project: Project, _ settings: PublicSettings?) -> [TicketStatus] { project.cosStatuses.optional ?? statuses(settings) }

    /// What a checkbox change saves: the columns in board order.
    public static func toggled(_ status: TicketStatus, on: Bool, in current: [TicketStatus]) -> [TicketStatus] {
        TicketStatus.allKnown.filter { $0 == status ? on : current.contains($0) }
    }

    /// triageDriver: the API's when the classifier uses the API, else Claude Code's.
    public static func triageDriver(_ settings: PublicSettings?) -> String {
        settings?.classifier == .anthropicApi ? "anthropic-api" : "claude-code"
    }

    /// triageDefaultModel (HAIKU_MODELS): the triage driver's Haiku, what an empty cosTriageModel runs on.
    public static func triageDefaultModel(_ settings: PublicSettings?) -> String {
        triageDriver(settings) == "anthropic-api" ? "claude-haiku-5-5" : "haiku"
    }

    /// resolveTriagePermissionMode: the setting, else read only.
    public static func triageMode(_ settings: PublicSettings?) -> TriagePermissionMode {
        settings?.cosTriagePermissionMode.optional ?? .readOnly
    }

    /// TRIAGE_PERMISSION_MODE_LABELS.
    public static let triageModeLabels: [TriagePermissionMode: Permissions.Label] = [
        .readOnly: Permissions.Label(label: "Read only", description: "Triage may run gh reads and read-only tools from a fixed list. Anything else is refused, and triage escalates the event instead."),
        .auto: Permissions.Label(
            label: "Auto",
            description: "A classifier judges each lookup: Claude Code's own when the triage model supports auto mode, Harness's when it doesn't (Haiku). Anything it won't allow is refused, and triage escalates the event instead."
        ),
    ]

    /// The driver and model a chief of staff runs on when its wake isn't about a project that chose one (resolveCosChoice):
    /// the app's CoS choice, else the app's Work choice.
    public static func appModel(_ settings: PublicSettings?) -> PhaseChoice {
        settings?.cosModel.optional ?? Phases.settingsPhaseChoice(settings?.phaseModels, .work)
    }

    /// The chief's model for a wake about `project` alone (resolveCosChoice): its own, else the app's.
    public static func model(project: Project?, settings: PublicSettings?) -> PhaseChoice {
        project?.cosModel ?? appModel(settings)
    }

    /// The drivers a CoS model picker offers (cosDrivers): those that can run a chief, and `keep` so a saved choice never vanishes.
    public static func drivers(_ all: [DriverInfo], keeping keep: String?) -> [DriverInfo] {
        all.filter { $0.runsCos != false || $0.id == keep }
    }

    /// A PhaseChoice as the picker's value: nil (the Default row) is no driver.
    public static func pickerChoice(_ c: PhaseChoice?) -> Watchers.TriageChoice {
        Watchers.TriageChoice(driver: c?.driver, model: c?.model)
    }

    /// What a picker pick saves: the Default row (no driver) clears the choice.
    public static func patch(_ c: Watchers.TriageChoice) -> Patch<PhaseChoice> {
        guard let driver = Models.nonEmpty(c.driver) else { return .null }
        return .value(PhaseChoice(driver: driver, model: c.model))
    }

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
    public static let openStatuses: [TicketEventStatus] = [.pending, .triaging, .escalated, .handling]

    /// A handled event shows what the chief recorded for it; one it recorded nothing for is only reviewed.
    public static func inboxState(status: TicketEventStatus, verdict: TicketEventVerdict, outcome: CosOutcome? = nil) -> CosInboxState {
        if verdict == .filtered { return .filtered }
        switch status {
        case .pending, .triaging: return .waiting
        case .ignored: return .ignored
        case .escalated: return .escalated
        case .handling: return .handling
        case .handled:
            switch outcome?.kind {
            case .acted: return .acted
            case .noAction: return .noAction
            case .needsUser: return .needsUser
            default: return .reviewed
            }
        case .unknown: return .waiting
        }
    }

    public static func inboxState(_ e: TicketEvent) -> CosInboxState { inboxState(status: e.status, verdict: e.verdict, outcome: e.outcome) }

    /// Ignored events (and only those) can be escalated by hand.
    public static func canEscalate(_ e: TicketEvent) -> Bool { e.status == .ignored && e.verdict != .filtered }

    /// The line a row says about the verdict: the reason for an ignored or escalated one, the chief's
    /// recorded outcome for a handled one, else nil.
    public static func verdictLine(_ e: TicketEvent) -> String? {
        switch inboxState(e) {
        case .ignored, .escalated: e.reason.flatMap { $0.isEmpty ? nil : $0 }
        case .acted, .noAction, .needsUser: e.outcome?.text
        default: nil
        }
    }

    public static func sourceLabel(_ s: TicketEventSource) -> String {
        switch s {
        case .activity: "Ticket"
        case .watcher: "Watcher"
        case .schedule: "Schedule"
        case .subscription: "Subscription"
        case .child: "Child"
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
    public static func mergeEvents(_ existing: [TicketEvent], _ incoming: [TicketEvent]) -> [TicketEvent] {
        var byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        for e in incoming { byId[e.id] = e }
        return byId.values.sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : JSString.less($1.id, $0.id) }
    }

    /// One thing a chat shows: a message, a short line for what the chief did, or a ticket card.
    public enum ChatRow: Equatable, Sendable, Identifiable {
        case message(id: String, fromHuman: Bool, text: String, attachments: [Attachment] = [])
        /// "Looked at 3 events: ignored 3 routine moves"; a wake is one line.
        case line(id: String, text: String)
        case ticket(id: String, key: String, title: String, status: String, moved: Bool)

        public var id: String {
            switch self {
            case let .message(id, _, _, _), let .line(id, _), let .ticket(id, _, _, _, _): id
            }
        }
    }

    /// The rows of a chat, oldest first. Entries this build doesn't know are left out.
    public static func rows(_ entries: [CosChatEntry]) -> [ChatRow] {
        entries.compactMap { e in
            switch e {
            case let .message(id, _, _, role, text, attachments): .message(id: id, fromHuman: role == "user", text: text, attachments: attachments)
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
}
