import HarnessKit
import SwiftUI

/// The ticket's tabs (TicketDetail.tsx TabStrip): Summaries, Tickets (conductors), Transcript,
/// Agents (once there are sub-agents), Browser, Details, then the plugin tabs. Counts and a live
/// dot ride along; a sub-agent's view highlights Agents.
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
        let builtin: [Item] = Tabs.ticketTabs
            .filter { ($0 != .children || conductor) && ($0 != .agents || Tabs.showsAgentsTab(subagents)) }
            .map { t in
                let count: Int? = switch t {
                case .summaries: state.summaries[ticket.sessionId]?.count ?? 0
                case .children: conductor ? state.childrenOf(ticket.id).count : 0
                case .agents: subagents?.count
                default: nil
                }
                let live = (t == .transcript && ticket.busy) || (t == .agents && (subagents?.contains { $0.status == .running } ?? false))
                return Item(id: TicketTab(t), label: Tabs.tabLabel[t] ?? t.rawValue, count: count, live: live)
            }
        let plugins = (pluginTabs ?? []).map { p in
            Item(id: Tabs.pluginTabRoute(p.pluginId, p.id), label: p.title, icon: p.icon.flatMap { Icons.isIconName($0) ? $0 : nil })
        }
        return builtin + plugins
    }

    private func button(_ item: Item, on: Bool) -> some View {
        Button {
            if !on { haptic(.select) }
            onTab(item.id)
        } label: {
            HStack(spacing: 5) {
                if let icon = item.icon { Icon(icon, size: 13).foregroundStyle(on ? c.text : c.text2) }
                Text(item.label)
                    .font(.system(size: 14.5, weight: on ? .semibold : .medium))
                    .foregroundStyle(on ? c.text : c.text2)
                if let count = item.count, count > 0 {
                    Text("\(count)")
                        .font(.system(size: 11.5, weight: .semibold))
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
        .accessibilityValue(item.count.flatMap { $0 > 0 ? "\($0)" : nil } ?? "")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }
}
