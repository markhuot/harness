import HarnessKit
import SwiftUI

/// FEATURE SLOT (Projects ticket): a project's settings (screens/ProjectSettings.tsx): name, key,
/// color, driver/model, permissions, base branch, completion. Replace the body.
struct ProjectSettingsScreen: View {
    let projectId: String

    var body: some View {
        SlotPlaceholder(name: "Project settings", params: [("project", projectId)])
            .navigationTitle("Project settings")
    }
}
