import HarnessKit
import SwiftUI

/// FEATURE SLOT (Ticket detail ticket): a ticket's header, tab strip and tabs (screens/
/// TicketDetail.tsx, TicketTabs.tsx), approvals and review actions. `key` may be a remote ID
/// (harness://ticket/JIRA-62 lists the tickets sharing it). `initialTab` is the link's `?tab=`,
/// already checked with Tabs.isTicketTab; nil lets the screen pick. Tabs host TranscriptView,
/// AgentsTabView, SubagentView, BrowserTabView and PluginTabView. Replace the body.
struct TicketDetailScreen: View {
    let key: String
    let initialTab: TicketTab?

    var body: some View {
        SlotPlaceholder(name: "Ticket", params: [("key", key), ("tab", initialTab?.rawValue ?? "—")])
            .navigationTitle(key)
            .navigationBarTitleDisplayMode(.inline)
    }
}
