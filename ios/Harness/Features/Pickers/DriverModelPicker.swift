import HarnessKit
import SwiftUI

/// FEATURE SLOT (Pickers ticket): one control picking a driver and model together
/// (ui/DriverModelPicker.tsx on Models.driverModelChoices). `resolved` is what Default falls back
/// to; `onlyDriver` lists one driver's models (a ticket mid-run keeps its driver);
/// `inheritedModel` names what a driver without a model falls back to. Replace the body.
struct DriverModelPicker: View {
    let value: Watchers.TriageChoice
    let resolved: Watchers.TriageChoice
    var title = "Model"
    var defaultLabel: String?
    var onlyDriver: String?
    var disabled = false
    var inheritedModel: ((String) -> String?)?
    let onChange: (Watchers.TriageChoice) -> Void

    var body: some View {
        LabeledContent(title, value: [value.driver, value.model].compactMap { $0 }.joined(separator: " · ").nilIfEmpty ?? (defaultLabel ?? "Default"))
    }
}

extension String {
    /// nil for "".
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
