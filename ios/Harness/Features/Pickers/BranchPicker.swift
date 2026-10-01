import HarnessKit
import SwiftUI

/// FEATURE SLOT (Pickers ticket): a project's branch, searchable, or a new one (ui/BranchPicker.tsx,
/// State/BranchRows). nil = the default (`defaultLabel`, e.g. "New branch harness/web-4");
/// `newLabel` labels a typed name the list doesn't have. `onChange` gets the picked row's entry so
/// the caller can hint at checkedOutAt. Replace the body.
struct BranchPicker: View {
    let projectId: String
    let value: String?
    let defaultLabel: String
    let newLabel: (String) -> String
    var title = "Branch"
    var disabled = false
    let onChange: (String?, BranchInfo?) -> Void

    var body: some View {
        LabeledContent(title, value: value ?? defaultLabel)
    }
}
