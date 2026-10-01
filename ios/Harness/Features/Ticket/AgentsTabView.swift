import HarnessKit
import SwiftUI

/// FEATURE SLOT (Agents ticket): the Agents tab, the ticket's sub-agents grouped by state
/// (screens/AgentsTab.tsx). Replace the body.
struct AgentsTabView: View {
    let ticket: Ticket

    var body: some View {
        SlotPlaceholder(name: "Agents", params: [("ticket", ticket.key)])
    }
}
