import SwiftUI

/// A text field with a local draft, committed on return or when it loses focus,
/// and only when it changed. An outside change to `value` resets the draft.
/// Use inside a Form row: `LabeledContent("Name") { DraftField(value: s.name, prompt: "Name") { rename($0) } }`.
struct DraftField: View {
    let value: String
    var prompt: String = ""
    var mono = false
    var alignment: TextAlignment = .trailing
    let onCommit: (String) -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool
    @Environment(\.palette) private var c

    var body: some View {
        TextField(prompt, text: $draft)
            .font(mono ? .mono(16) : .body)
            .foregroundStyle(c.text)
            .multilineTextAlignment(alignment)
            .submitLabel(.done)
            .focused($focused)
            .onAppear { draft = value }
            .onChange(of: value) { _, v in draft = v }
            .onSubmit(commit)
            .onChange(of: focused) { _, now in if !now { commit() } }
    }

    private func commit() {
        if draft != value { onCommit(draft) }
    }
}
