import HarnessKit
import SwiftUI

/// A project's chief of staff switches: each is the project's own On or Off, or Inherit, which
/// follows the app's setting (shown beside it).
struct ProjectCosSection: View {
    let project: Project
    let settings: PublicSettings?
    let save: (UpdateProjectBody) -> Void

    var body: some View {
        Section {
            row("CoS enabled", hint: "Whether chiefs of staff handle this project's events. Inherit follows the app setting.", value: project.cosEnabled, app: CosSettings.enabled(settings)) {
                save(UpdateProjectBody(cosEnabled: $0))
            }
            row("CoS can unblock", hint: "Whether a chief of staff may answer this project's blocked tickets itself. Inherit follows the app setting.", value: project.cosCanUnblock, app: CosSettings.canUnblock(settings)) {
                save(UpdateProjectBody(cosCanUnblock: $0))
            }
        } header: {
            Text("Chief of staff")
        }
    }

    private func row(_ label: String, hint: String, value: Patch<Bool>, app: Bool, set: @escaping (Patch<Bool>) -> Void) -> some View {
        SettingsRow(label: label, hint: hint) {
            SelectMenu(
                value: CosTriState(value),
                options: CosTriState.allCases.map { PickerOption(value: $0, label: CosSettings.label($0, inherited: app)) },
                title: label,
                accessibilityName: label
            ) { set($0.patch) }
        }
    }
}
