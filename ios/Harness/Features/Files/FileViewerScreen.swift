import HarnessKit
import SwiftUI

/// FEATURE SLOT (File viewer ticket): a file or diff in a ticket's or project's folder, scrolled
/// to the linked lines (screens/FileViewer.tsx, lib/fileViewer). `params` are the route's raw
/// strings; check them with `FileViewer.readFileParams(params)`. Replace the body.
struct FileViewerScreen: View {
    let params: FileRouteParams

    var body: some View {
        SlotPlaceholder(name: "File", params: [
            ("path", params.path),
            ("ticket", params.ticket ?? "—"),
            ("project", params.project ?? "—"),
            ("lines", params.start.map { "\($0)–\(params.end ?? $0)" } ?? "—"),
        ])
        .navigationBarTitleDisplayMode(.inline)
    }
}
