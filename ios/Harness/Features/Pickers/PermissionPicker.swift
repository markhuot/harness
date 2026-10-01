import HarnessKit
import SwiftUI

/// A permission mode, nil = inherit (ui/selects.tsx PermissionPicker): "Default (<inherited>)",
/// then each mode with its description as the subtitle.
struct PermissionPicker: View {
    let value: PermissionMode?
    var inherited: PermissionMode?
    var disabled = false
    let onChange: (PermissionMode?) -> Void

    var body: some View {
        SelectMenu(
            value: value,
            options: PickerLogic.permissionOptions(inherited: inherited),
            label: PickerLogic.permissionLabel(value: value, inherited: inherited),
            title: "Permission mode",
            disabled: disabled,
            accessibilityName: "Permission mode",
            onChange: onChange
        )
    }
}
