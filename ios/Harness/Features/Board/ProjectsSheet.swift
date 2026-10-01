import HarnessKit
import SwiftUI

/// FEATURE SLOT (Projects ticket): the Projects sheet (screens/Projects.tsx): pick the board's
/// project filter, open a project's settings. Presented as a sheet with medium/large detents by
/// the shell; `fromSearch` is set when the Search tab opened it. Replace the body.
struct ProjectsSheet: View {
    let fromSearch: Bool

    var body: some View {
        SlotPlaceholder(name: "Projects", params: [("fromSearch", String(fromSearch))])
            .navigationTitle("Projects")
    }
}
