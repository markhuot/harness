import HarnessKit
import SwiftUI

/// FEATURE SLOT (Inbox ticket): the Inbox tab, triage sessions with their outcomes
/// (screens/Inbox.tsx). Rows push `.triage(sessionId:)`. Replace the body.
struct InboxScreen: View {
    var body: some View {
        SlotPlaceholder(name: "Inbox")
            .navigationTitle("Inbox")
            .safeAreaInset(edge: .top) { ConnectionBanner() }
    }
}
