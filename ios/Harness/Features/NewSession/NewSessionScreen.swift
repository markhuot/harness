import HarnessKit
import SwiftUI

/// FEATURE SLOT (New session ticket): the New session sheet (screens/NewSession.tsx, lib/
/// newSession, draftSync): project, prompt with mentions, driver/model, branch, Options. `key`
/// resumes a planning ticket's draft. The shell wraps it in a NavigationStack. Replace the body.
struct NewSessionScreen: View {
    let projectId: String?
    let key: String?

    var body: some View {
        SlotPlaceholder(name: "New session", params: [("projectId", projectId ?? "—"), ("key", key ?? "—")])
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
    }
}
