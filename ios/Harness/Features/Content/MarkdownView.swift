import HarnessKit
import SwiftUI

/// FEATURE SLOT (Markdown ticket): rendered markdown with code blocks, tables, file links and
/// mentions (ui/Markdown.tsx on HarnessKit's Markdown blocks). `size` is the body text size;
/// `color` overrides the text color (nil = palette text). File links resolve against the
/// ticket/project the caller passes. Replace the body.
///
/// The placeholder draws Markdown.plainText so screens read sensibly before it lands.
struct MarkdownView: View {
    let text: String
    var size: CGFloat = 15
    var color: Color?
    /// Where relative file links open (the ticket's folder, else the project's).
    var linkContext = FileLinkContext()

    @Environment(\.palette) private var c

    var body: some View {
        Text(Markdown.plainText(text))
            .font(.system(size: size))
            .foregroundStyle(color ?? c.text)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
