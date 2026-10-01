import HarnessKit
import SwiftUI

/// FEATURE SLOT (Inbox ticket): one triage item: the watcher output, the triage transcript and
/// what it dispatched (app/inbox/[id].tsx). Replace the body.
struct TriageScreen: View {
    let sessionId: String

    var body: some View {
        SlotPlaceholder(name: "Triage", params: [("session", sessionId)])
            .navigationBarTitleDisplayMode(.inline)
    }
}
