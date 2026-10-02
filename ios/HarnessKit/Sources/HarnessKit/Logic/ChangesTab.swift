import Foundation

// The Changes tab is built into the native app (HARNESS-153): it draws the ticket's diff natively
// instead of hosting the git plugin's page. The service still offers it as the git plugin's
// "changes" tab, so this layer sits on top of Tabs (a fixture-checked port of shared/src/state/tabs.ts,
// which doesn't know about it yet): it maps "plugin:git:changes" to the built-in "changes" tab,
// keeps git:changes out of the plugin tabs, and decides when the tab shows.

extension TicketTab {
    /// The built-in Changes tab.
    public static let changes = TicketTab("changes")
}

public enum ChangesTab {
    public static let label = "Changes"
    public static let pluginId = "git"
    public static let tabId = "changes"

    /// The plugin tab the built-in one replaces.
    public static let pluginRoute = Tabs.pluginTabRoute(pluginId, tabId)

    public static func isPluginChanges(_ tab: PluginTab) -> Bool { tab.pluginId == pluginId && tab.id == tabId }

    /// "plugin:git:changes" (old links and the RN app's tab id) → "changes"; every other tab as is.
    public static func normalize(_ tab: TicketTab) -> TicketTab { tab == pluginRoute ? .changes : tab }

    /// Tabs.isTicketTab, plus "changes".
    public static func isTicketTab(_ t: String?) -> Bool {
        guard let t else { return false }
        return TicketTab(t) == .changes || Tabs.isTicketTab(t)
    }

    /// The ticket's plugin tabs without git:changes, which the built-in tab replaces. Nil stays nil
    /// (not loaded yet).
    public static func otherPluginTabs(_ tabs: [PluginTab]?) -> [PluginTab]? {
        tabs?.filter { !isPluginChanges($0) }
    }

    /// Whether the ticket has a Changes tab: it has a workdir, or the service still offers the git
    /// plugin's tab (its diff was pinned before the worktree was removed; git plugin `showTab`).
    public static func shows(workdir: String?, pluginTabs: [PluginTab]?) -> Bool {
        workdir != nil || (pluginTabs?.contains(where: isPluginChanges) ?? false)
    }

    /// Tabs.effectiveTab with the built-in Changes tab: shown while it applies (and while the plugin
    /// tabs that could say it does aren't loaded yet), else Summaries.
    public static func effectiveTab(_ requested: TicketTab, conductor: Bool, workdir: String?, pluginTabs: [PluginTab]?, subagents: [Subagent]? = nil) -> TicketTab {
        let tab = normalize(requested)
        if tab == .changes {
            return shows(workdir: workdir, pluginTabs: pluginTabs) || pluginTabs == nil ? .changes : .summaries
        }
        return Tabs.effectiveTab(tab, conductor: conductor, pluginTabs: otherPluginTabs(pluginTabs), subagents: subagents)
    }

    /// Tabs.visibleTabs with Changes after Browser, ahead of Details.
    public static func visibleTabs(conductor: Bool, workdir: String?, subagents: [Subagent]?, pluginTabs: [PluginTab]?) -> [TicketTab] {
        var tabs = Tabs.visibleTabs(conductor: conductor, subagents: subagents, pluginTabs: otherPluginTabs(pluginTabs))
        if shows(workdir: workdir, pluginTabs: pluginTabs), let i = tabs.firstIndex(of: .details) { tabs.insert(.changes, at: i) }
        return tabs
    }
}

/// The unified/split preference (plugins/git/ui/prefs.ts), kept in UserDefaults so it carries over
/// from one ticket to the next.
public enum ChangesDiffStyle: String, Sendable, Equatable, CaseIterable {
    case unified, split

    public static let key = "harness.git.diffStyle"
    /// The plugin picks split on its own from this width up, when nobody chose a style.
    public static let autoSplitWidth: Double = 1000
    /// Below this width split columns are too narrow to read, so a chosen split shows unified (the
    /// choice is kept for wider screens).
    public static let minSplitWidth: Double = 560

    /// The style the user picked, or nil when they haven't picked one (or it's unreadable).
    public static func read(_ store: any ChangesDefaults) -> ChangesDiffStyle? {
        store.string(forKey: key).flatMap(ChangesDiffStyle.init(rawValue:))
    }

    public static func save(_ style: ChangesDiffStyle, to store: any ChangesDefaults) {
        store.setString(style.rawValue, forKey: key)
    }

    /// The style to draw at `width`: the plugin's automatic pick when nothing was chosen, and unified
    /// on a screen too narrow for split.
    public static func effective(chosen: ChangesDiffStyle?, width: Double) -> ChangesDiffStyle {
        let want = chosen ?? (width >= autoSplitWidth ? .split : .unified)
        return want == .split && width < minSplitWidth ? .unified : want
    }
}
