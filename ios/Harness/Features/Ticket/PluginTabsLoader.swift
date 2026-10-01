import HarnessKit
import SwiftUI

extension View {
    /// The plugin tabs that apply to a ticket (PluginTab.tsx `usePluginTabs`, GET
    /// /tickets/:key/tabs): nil until loaded, [] when the request fails. Refetched when the
    /// ticket's worktree or branch changes and on every reconnect. The ticket detail screen's tab
    /// strip reads this and hosts each tab in PluginTabView.
    func pluginTabs(for ticket: Ticket?, into tabs: Binding<[PluginTab]?>) -> some View {
        modifier(PluginTabsLoader(ticket: ticket, tabs: tabs))
    }
}

private struct PluginTabsLoader: ViewModifier {
    let ticket: Ticket?
    @Binding var tabs: [PluginTab]?
    @Environment(BoardStore.self) private var store

    private struct Key: Hashable {
        let key: String
        let workdir: String?
        let branch: String?
        let epoch: Int
    }

    func body(content: Content) -> some View {
        content.task(id: ticket.map { Key(key: $0.key, workdir: $0.workdir, branch: $0.branch, epoch: store.epoch) }) {
            guard let key = ticket?.key, let client = store.client as? HarnessClient else { return }
            let result = (try? await client.ticketTabs(key)) ?? []
            if !Task.isCancelled { tabs = result }
        }
    }
}
