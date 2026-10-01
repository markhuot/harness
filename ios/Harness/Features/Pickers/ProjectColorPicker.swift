import HarnessKit
import SwiftUI

/// FEATURE SLOT (Projects ticket): a project's key color from the shared palette, nil = the
/// theme accent (ui/ProjectColor.tsx, ProjectColors.swift). Replace the body.
struct ProjectColorPicker: View {
    let value: String?
    let onChange: (String?) -> Void

    var body: some View {
        LabeledContent("Color", value: value ?? "Accent")
    }
}
