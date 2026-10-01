import HarnessKit
import SwiftUI

/// FEATURE SLOT (Ticket detail ticket): a ticket's editable settings rows (driver/model,
/// permissions, branch, base branch, dependencies, skip agent review; ui/TicketSettings.tsx).
/// Sends changes as an UpdateTicketBody through `onPatch`. Replace the body.
struct TicketSettingsForm: View {
    let ticket: Ticket
    let onPatch: (UpdateTicketBody) -> Void

    var body: some View {
        SlotPlaceholder(name: "Ticket settings", params: [("ticket", ticket.key)])
    }
}
