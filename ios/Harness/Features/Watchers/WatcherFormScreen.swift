import HarnessKit
import SwiftUI

/// FEATURE SLOT (Watchers ticket): the watcher form in a sheet (screens/WatcherForm.tsx,
/// lib/watcherDraft). nil `id` is a new watcher. The shell wraps it in a NavigationStack; close
/// with `@Environment(\.dismiss)`. Replace the body.
struct WatcherFormScreen: View {
    let id: String?

    var body: some View {
        SlotPlaceholder(name: "Watcher", params: [("id", id ?? "new")])
            .navigationTitle("Watcher")
            .navigationBarTitleDisplayMode(.inline)
    }
}
