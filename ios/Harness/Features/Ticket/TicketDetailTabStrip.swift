import HarnessKit
import SwiftUI

/// The ticket's tabs: Spec, Activity, Tickets (conductors), Transcript,
/// Agents & tasks (once there are sub-agents or background tasks), Browser, Changes (when the service
/// lists the git plugin's tab), Details, then the plugin tabs. Counts and a live dot ride along; a
/// sub-agent's or task's view highlights Agents & tasks.
struct TicketDetailTabStrip: View {
    let ticket: Ticket
    /// The tab shown (already through Tabs.effectiveTab)
    let tab: TicketTab
    let pluginTabs: [PluginTab]?
    let onTab: (TicketTab) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    private struct Item: Identifiable {
        let id: TicketTab
        let label: String
        var count: Int?
        var live = false
        /// What the live dot means, for VoiceOver
        var liveLabel: String?
        var icon: String?
    }

    var body: some View {
        let strip = Tabs.tabStripTab(tab)
        ScrollView(.horizontal) {
            HStack(spacing: 0) {
                ForEach(items) { item in
                    button(item, on: item.id == strip)
                }
            }
            .padding(.horizontal, 8)
        }
        .scrollIndicators(.hidden)
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
    }

    private var items: [Item] {
        let state = store.state
        let subagents = state.subagentsOf(ticket.sessionId)
        let conductor = ticket.isConductor
        // The order, Changes included (built in; the git plugin's own tab never shows), is
        // ChangesTab.visibleTabs'; this adds labels, counts, live dots and plugin icons.
        let plugins = ChangesTab.otherPluginTabs(pluginTabs) ?? []
        return ChangesTab.visibleTabs(conductor: conductor, workdir: ticket.workdir, subagents: subagents, pluginTabs: pluginTabs).map { tab in
            if tab == .changes {
                let icon = ChangesTab.icon(pluginTabs)
                return Item(id: tab, label: ChangesTab.label, icon: Icons.isIconName(icon) ? icon : ChangesTab.defaultIcon)
            }
            if let t = tab.builtin {
                let count: Int? = switch t {
                case .activity: state.activity[ticket.sessionId]?.count ?? 0
                case .children: conductor ? state.childrenOf(ticket.id).count : 0
                case .agents: subagents?.count
                default: nil
                }
                let agentsLive = t == .agents && (subagents?.contains { $0.status == .running } ?? false)
                let live = (t == .transcript && ticket.busy) || agentsLive
                return Item(id: tab, label: Tabs.tabLabel[t] ?? t.rawValue, count: count, live: live, liveLabel: agentsLive ? Tabs.agentsLiveLabel : nil)
            }
            let p = plugins.first { Tabs.pluginTabRoute($0.pluginId, $0.id) == tab }
            return Item(id: tab, label: p?.title ?? tab.rawValue, icon: p?.icon.flatMap { Icons.isIconName($0) ? $0 : nil })
        }
    }

    private func button(_ item: Item, on: Bool) -> some View {
        Button {
            if !on { haptic(.select) }
            onTab(item.id)
        } label: {
            HStack(spacing: 5) {
                if let icon = item.icon { Icon(icon, size: 13).foregroundStyle(on ? c.text : c.text2) }
                Text(item.label)
                    .font(.scaled(size: 14.5, weight: on ? .semibold : .medium))
                    .foregroundStyle(on ? c.text : c.text2)
                if let count = item.count, count > 0 {
                    Text("\(count)")
                        .font(.scaled(size: 11.5, weight: .semibold))
                        .foregroundStyle(c.text2)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(c.bgActive, in: .capsule)
                }
                if item.live { Circle().fill(c.inProgress).frame(width: 7, height: 7) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 11)
            .overlay(alignment: .bottom) { Rectangle().fill(on ? c.accent : .clear).frame(height: 2) }
            .contentShape(.rect)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.label)
        .accessibilityValue([item.count.flatMap { $0 > 0 ? "\($0)" : nil }, item.liveLabel].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }
}
