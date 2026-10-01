import HarnessKit
import SwiftUI

/// FEATURE SLOT (Transcript / New session tickets): a multiline editor with `@file` mentions and
/// `/command` completion (ui/mentions.tsx, Logic/Mentions, MentionCaret, Commands). The
/// mention list searches files in the ticket's folder (`ticketKey`) or the project's
/// (`projectId`). Replace the body.
struct MentionTextEditor: View {
    @Binding var text: String
    var placeholder = ""
    var projectId: String?
    var ticketKey: String?
    var minHeight: CGFloat = 80

    var body: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(3...12)
            .frame(minHeight: minHeight, alignment: .top)
            .accessibilityLabel(placeholder)
    }
}
