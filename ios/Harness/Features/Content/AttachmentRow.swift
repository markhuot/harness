import HarnessKit
import SwiftUI

/// FEATURE SLOT (Summaries & attachments ticket): a summary's attachment thumbnails, opening the
/// full-screen viewer (ui/Attachments.tsx, lib/attachments). Thumbnails need the store's client
/// for authenticated URLs. Replace the body.
struct AttachmentRow: View {
    let attachments: [SummaryAttachment]

    @Environment(\.palette) private var c

    var body: some View {
        if !attachments.isEmpty {
            HStack(spacing: 6) {
                ForEach(attachments) { a in Badge(a.name, outline: true, icon: "image") }
            }
        }
    }
}
