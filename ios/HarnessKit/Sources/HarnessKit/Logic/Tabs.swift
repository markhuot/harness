import Foundation

// Port of shared/src/state/tabs.ts. Ticket detail tabs, shared by every client: the built-in tabs,
// plugin tabs addressed as "plugin:<pluginId>:<tabId>" (DESIGN.md "Plugins") and one sub-agent's
// transcript or task output as "agent:<subagentId>" (under the Agents & tasks tab, DESIGN.md
// "Sub-agents", "Background tasks"). The desktop
// puts these in its hash route; the phone keeps them in navigation params.

/// "spec" is the ticket's living document and the tab a ticket opens on; "activity" its typed
/// timeline. "children" is the conductor-only Tickets tab (listed right after Activity). "agents"
/// (Agents & tasks) lists the session's sub-agents and background tasks; it exists only once there
/// are any.
public enum BuiltinTicketTab: String, Codable, Sendable, CaseIterable {
    case spec, activity, children, transcript, agents, browser, details
}

/// Built-in tabs, a plugin tab as "plugin:<pluginId>:<tabId>", or a sub-agent as "agent:<id>".
///
/// A string, as in TS (where the template-literal type admits strings the parsers reject), so
/// a requested tab round-trips untouched. Equality is code-point equality (JS `===`).
public struct TicketTab: RawRepresentable, Codable, Sendable, Hashable, ExpressibleByStringLiteral, CustomStringConvertible {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { rawValue = value }
    public init(_ builtin: BuiltinTicketTab) { rawValue = builtin.rawValue }

    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public static func == (a: TicketTab, b: TicketTab) -> Bool { a.rawValue.unicodeScalars.elementsEqual(b.rawValue.unicodeScalars) }
    public func hash(into hasher: inout Hasher) {
        for s in rawValue.unicodeScalars { hasher.combine(s.value) }
    }
    public var description: String { rawValue }

    /// The built-in tab this is, if it is one.
    public var builtin: BuiltinTicketTab? { Tabs.ticketTabs.first { $0.rawValue.unicodeScalars.elementsEqual(rawValue.unicodeScalars) } }

    public static let spec = TicketTab(.spec)
    public static let activity = TicketTab(.activity)
    public static let children = TicketTab(.children)
    public static let transcript = TicketTab(.transcript)
    public static let agents = TicketTab(.agents)
    public static let browser = TicketTab(.browser)
    public static let details = TicketTab(.details)
}

public enum Tabs {
    /// A plugin tab's address: `{ pluginId, id }` (PluginTab carries more).
    public struct PluginTabID: Codable, Sendable, Equatable {
        public var pluginId: String
        public var id: String
        public init(pluginId: String, id: String) {
            self.pluginId = pluginId
            self.id = id
        }
        public init(_ tab: PluginTab) { self.init(pluginId: tab.pluginId, id: tab.id) }
    }

    /// `parsePluginTab`'s result.
    public struct ParsedPluginTab: Codable, Sendable, Equatable {
        public var pluginId: String
        public var tabId: String
        public init(pluginId: String, tabId: String) {
            self.pluginId = pluginId
            self.tabId = tabId
        }
    }

    public static let ticketTabs: [BuiltinTicketTab] = BuiltinTicketTab.allCases

    public static let tabLabel: [BuiltinTicketTab: String] = [
        .spec: "Spec",
        .activity: "Activity",
        .children: "Tickets",
        .transcript: "Transcript",
        .agents: "Agents & tasks",
        .browser: "Browser",
        .details: "Details",
    ]

    public static func pluginTabRoute(_ pluginId: String, _ tabId: String) -> TicketTab {
        TicketTab("plugin:\(pluginId):\(tabId)")
    }

    /// "plugin:git:changes" → { pluginId: "git", tabId: "changes" }; nil for built-in tabs.
    /// (`/^plugin:([a-z0-9][a-z0-9_-]*):([a-z0-9][a-z0-9_-]*)$/`)
    public static func parsePluginTab(_ tab: String) -> ParsedPluginTab? {
        let s = Array(tab.unicodeScalars)
        let prefix = Array("plugin:".unicodeScalars)
        guard s.count > prefix.count, s.starts(with: prefix) else { return nil }
        let parts = s[prefix.count...].split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts.allSatisfy(isPluginId) else { return nil }
        return ParsedPluginTab(pluginId: string(parts[0]), tabId: string(parts[1]))
    }

    public static func parsePluginTab(_ tab: TicketTab) -> ParsedPluginTab? { parsePluginTab(tab.rawValue) }

    /// The tab showing one sub-agent's transcript.
    public static func subagentTabRoute(_ subagentId: String) -> TicketTab {
        TicketTab("agent:\(subagentId)")
    }

    /// "agent:toolu_01" → "toolu_01"; nil for every other tab. Tool call ids (the sub-agent ids
    /// Claude Code gives) are letters, digits, "_" and "-". (`/^agent:([A-Za-z0-9_-]{1,128})$/`)
    public static func parseSubagentTab(_ tab: String) -> String? {
        let s = Array(tab.unicodeScalars)
        let prefix = Array("agent:".unicodeScalars)
        guard s.starts(with: prefix) else { return nil }
        let id = s[prefix.count...]
        guard (1...128).contains(id.count), id.allSatisfy({ isASCIIAlnum($0) || $0 == "_" || $0 == "-" }) else { return nil }
        return string(id)
    }

    public static func parseSubagentTab(_ tab: TicketTab) -> String? { parseSubagentTab(tab.rawValue) }

    /// The tab strip entry a tab belongs to: a sub-agent's transcript sits under Agents & tasks.
    public static func tabStripTab(_ tab: TicketTab) -> TicketTab {
        parseSubagentTab(tab) != nil ? .agents : tab
    }

    public static func isTicketTab(_ t: String?) -> Bool {
        guard let t, !t.isEmpty else { return false }
        return TicketTab(t).builtin != nil || parsePluginTab(t) != nil || parseSubagentTab(t) != nil
    }

    /// Tab ids older links and saved routes may still carry, and the tab each one became.
    public static let renamedTabs: [String: BuiltinTicketTab] = ["summaries": .spec]

    /// A tab id from a link or saved route, with renamed ids mapped to their new tab; nil when it isn't one.
    public static func ticketTabFrom(_ t: String?) -> TicketTab? {
        guard let t, !t.isEmpty else { return nil }
        if let renamed = renamedTabs.first(where: { same($0.key, t) })?.value { return TicketTab(renamed) }
        return isTicketTab(t) ? TicketTab(t) : nil
    }

    /// The tab to show once the composer's send finished: the Transcript after a message went
    /// through, from any tab, since that's where it and the agent's reply show (messages never go
    /// into Activity); the same tab when the send failed, so the human stays where the error found
    /// them.
    public static func tabAfterSend(_ tab: TicketTab, sent: Bool) -> TicketTab {
        sent ? .transcript : tab
    }

    /// The live dot's label on the Agents & tasks tab.
    public static let agentsLiveLabel = "A sub-agent or task is running"

    /// Whether the tab strip shows Agents & tasks: only once the session has sub-agents or tasks to list.
    public static func showsAgentsTab(subagentIds: [String]?) -> Bool {
        (subagentIds?.count ?? 0) > 0
    }

    public static func showsAgentsTab(_ subagents: [Subagent]?) -> Bool {
        showsAgentsTab(subagentIds: subagents?.map(\.id))
    }

    /// The tab to show for a requested one: a plugin tab that doesn't apply (once the ticket's plugin
    /// tabs are known) and the conductor-only Tickets tab on a plain ticket fall back to the Spec.
    /// The Agents & tasks tab and a sub-agent's view need sub-agents: without any (or before they're known)
    /// they fall back to the Spec, and a sub-agent that isn't among them falls back to the list.
    /// The requested tab is kept by the caller, so a deep link opens once the sub-agents arrive.
    public static func effectiveTab(_ requested: TicketTab, conductor: Bool, pluginTabs: [PluginTabID]?, subagentIds: [String]? = nil) -> TicketTab {
        if requested == .children && !conductor { return .spec }
        if tabStripTab(requested) == .agents {
            guard let subagentIds, showsAgentsTab(subagentIds: subagentIds) else { return .spec }
            if let agent = parseSubagentTab(requested), !subagentIds.contains(where: { same($0, agent) }) { return .agents }
        }
        if let p = parsePluginTab(requested), let pluginTabs,
           !pluginTabs.contains(where: { same($0.pluginId, p.pluginId) && same($0.id, p.tabId) }) {
            return .spec
        }
        return requested
    }

    public static func effectiveTab(_ requested: TicketTab, conductor: Bool, pluginTabs: [PluginTab]?, subagents: [Subagent]? = nil) -> TicketTab {
        effectiveTab(requested, conductor: conductor, pluginTabs: pluginTabs?.map(PluginTabID.init), subagentIds: subagents?.map(\.id))
    }

    /// The tab a ticket opens on when nothing asked for a particular one: the Spec, which every
    /// ticket has from the start.
    public static func openingTab() -> TicketTab { .spec }

    /// The tab strip, in order: the built-in tabs this ticket shows (Tickets only on a conductor, Agents &
    /// tasks only once there are sub-agents or tasks), then its plugin tabs. ⌘⇧[ / ⌘⇧] and 1–9 walk this list.
    public static func visibleTabs(conductor: Bool, subagentIds: [String]? = nil, pluginTabs: [PluginTabID]? = nil) -> [TicketTab] {
        let builtin = ticketTabs.filter { ($0 != .children || conductor) && ($0 != .agents || showsAgentsTab(subagentIds: subagentIds)) }
        return builtin.map(TicketTab.init) + (pluginTabs ?? []).map { pluginTabRoute($0.pluginId, $0.id) }
    }

    public static func visibleTabs(conductor: Bool, subagents: [Subagent]?, pluginTabs: [PluginTab]?) -> [TicketTab] {
        visibleTabs(conductor: conductor, subagentIds: subagents?.map(\.id), pluginTabs: pluginTabs?.map(PluginTabID.init))
    }

    /// The tab `delta` steps from `current` in `tabs`, wrapping at both ends (like Chrome's ⌘⇧]). A
    /// sub-agent's view counts as the Agents & tasks tab; from a tab that isn't in the strip, forward goes to
    /// the first tab and back to the last. Nil when there are no tabs.
    public static func nextTab(_ tabs: [TicketTab], current: TicketTab, delta: Int) -> TicketTab? {
        guard !tabs.isEmpty else { return nil }
        let strip = tabStripTab(current)
        let from = tabs.firstIndex(of: strip) ?? (delta > 0 ? -1 : 0)
        let n = tabs.count
        return tabs[(((from + delta) % n) + n) % n]
    }

    // MARK: Helpers

    /// `[a-z0-9][a-z0-9_-]*`
    private static func isPluginId(_ s: ArraySlice<Unicode.Scalar>) -> Bool {
        guard let first = s.first, ("a"..."z").contains(first) || ("0"..."9").contains(first) else { return false }
        return s.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-" }
    }

    private static func isASCIIAlnum(_ c: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(c) || ("A"..."Z").contains(c) || ("0"..."9").contains(c)
    }

    private static func same(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }

    private static func string(_ s: some Sequence<Unicode.Scalar>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s)
        return String(v)
    }
}
