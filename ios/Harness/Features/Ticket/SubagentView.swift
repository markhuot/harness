import HarnessKit
import SwiftUI

/// FEATURE SLOT (Agents ticket): one sub-agent's header and transcript (the `agent:<id>` tab,
/// screens/AgentsTab.tsx). Replace the body.
struct SubagentView: View {
    let ticket: Ticket
    let subagentId: String

    var body: some View {
        SlotPlaceholder(name: "Sub-agent", params: [("ticket", ticket.key), ("agent", subagentId)])
    }
}
