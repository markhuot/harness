import HarnessKit
import SwiftUI

/// FEATURE SLOT (Transcript ticket): a session's transcript with the composer, mentions and slash
/// commands (screens/Transcript.tsx). `subagentId` scopes it to one sub-agent's entries.
/// Replace the body.
struct TranscriptView: View {
    let sessionId: String
    var subagentId: String?

    var body: some View {
        SlotPlaceholder(name: "Transcript", params: [("session", sessionId), ("subagent", subagentId ?? "—")])
    }
}
