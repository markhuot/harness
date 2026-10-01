import HarnessKit
import SwiftUI

/// FEATURE SLOT (Pickers ticket): one driver's model (ui/selects.tsx ModelPicker on
/// Models.modelOptions). nil value = Default (`inherited` names what that is). Replace the body.
struct ModelPicker: View {
    let driver: String
    let value: String?
    var inherited: String?
    var defaultLabel: String?
    var plainDefault = false
    var title = "Model"
    var disabled = false
    let onChange: (String?) -> Void

    var body: some View {
        LabeledContent(title, value: value ?? defaultLabel ?? "Default")
    }
}
