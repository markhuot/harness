import HarnessKit
import SwiftUI

/// FEATURE SLOT (Pickers ticket): a permission mode, nil = inherit (ui/selects.tsx
/// PermissionPicker; Permissions.swift has the labels and the never-looser rule). Replace the body.
struct PermissionPicker: View {
    let value: PermissionMode?
    var inherited: PermissionMode?
    var disabled = false
    let onChange: (PermissionMode?) -> Void

    var body: some View {
        LabeledContent("Permissions", value: value?.rawValue ?? inherited.map { "Inherit (\($0.rawValue))" } ?? "Inherit")
    }
}
