import HarnessKit
import SwiftUI

/// The "…" menu's view items, the same on the file viewer and the Spec tab: Source / Rendered, Show
/// changes (Spec tab) and Wrap lines (source only: rendered text always wraps). What's offered and
/// enabled is HarnessKit's ViewMenu.
struct ViewMenuSection: View {
    let menu: ViewMenu
    let wrap: Bool
    let setRendered: (Bool) -> Void
    let setWrap: (Bool) -> Void
    var showChanges = false
    var setShowChanges: ((Bool) -> Void)?

    var body: some View {
        if menu.view {
            Button { setRendered(false) } label: {
                Label("Source", systemImage: menu.rendered ? "doc.plaintext" : "checkmark")
            }
            .disabled(!menu.sourceEnabled)
            Button { setRendered(true) } label: {
                Label("Rendered", systemImage: menu.rendered ? "checkmark" : "doc.richtext")
            }
        }
        if menu.showChanges, let setShowChanges {
            Toggle(isOn: Binding(get: { showChanges }, set: setShowChanges)) {
                Label("Show changes", systemImage: "arrow.triangle.branch")
            }
        }
        Toggle(isOn: Binding(get: { wrap }, set: setWrap)) {
            Label("Wrap lines", systemImage: "text.alignleft")
        }
        .disabled(!menu.wrapEnabled)
    }
}
