import HarnessKit
import SwiftUI

/// FEATURE SLOT (Browser ticket): the session's live browser, screencast frames and touch/keyboard
/// input (screens/BrowserTab.tsx, lib/browserInput). Replace the body.
struct BrowserTabView: View {
    let ticket: Ticket

    var body: some View {
        SlotPlaceholder(name: "Browser", params: [("ticket", ticket.key), ("session", ticket.sessionId)])
    }
}
