import HarnessKit
import SwiftUI

/// FEATURE SLOT (Markdown / File viewer tickets): a highlighted code or diff block
/// (ui/CodeBlock.tsx on HarnessHighlight; see ARCHITECTURE.md § Syntax highlighting: diff tints
/// are full-width row backgrounds). `language` is a Shiki id (map fences with Code.codeLanguage);
/// `highlightLines` is 1-based and inclusive. Replace the body.
struct CodeBlockView: View {
    let code: String
    var language: String?
    var showLineNumbers = false
    var highlightLines: ClosedRange<Int>?

    @Environment(\.palette) private var c

    var body: some View {
        ScrollView(.horizontal) {
            Text(code).font(.mono(12.5)).foregroundStyle(c.text).textSelection(.enabled).padding(10)
        }
        .background(c.bgSunken, in: .rect(cornerRadius: 8))
    }
}
