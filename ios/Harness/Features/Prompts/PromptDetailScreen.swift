import HarnessKit
import SwiftUI

/// One prompt: its badge and description, the built-in
/// text read-only, or the customized text in an editor with a diff against the built-in, the
/// variables it can use, Customize / Reset to built-in, and Save in the header. While there's
/// something to cancel, Cancel stands in for Back (and the swipe back is off), so edits aren't lost.
struct PromptDetailScreen: View {
    let id: String

    @Environment(\.palette) private var c
    @State private var catalog = PromptCatalog()

    var body: some View {
        ZStack {
            if let prompts = catalog.prompts {
                if let entry = prompts.first(where: { $0.id.rawValue == id }) {
                    PromptDetailView(entry: entry, catalog: catalog).id(entry.id)
                } else {
                    EmptyState(icon: "fileText", title: "This prompt doesn't exist in this version of Harness")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(c.bg)
                }
            } else {
                PromptsLoading(error: catalog.error)
            }
        }
        .loadingPrompts(catalog)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PromptDetailView: View {
    let entry: PromptEntry
    let catalog: PromptCatalog

    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c

    /// nil: showing the built-in read-only; a string: the text being edited.
    @State private var draft: String?
    @State private var compare = false
    @State private var serverError: String?
    @State private var saving = false
    @State private var confirm: Confirmation?
    @State private var handle = PromptEditorHandle()

    init(entry: PromptEntry, catalog: PromptCatalog) {
        self.entry = entry
        self.catalog = catalog
        _draft = State(initialValue: entry.override)
        let handle = PromptEditorHandle()
        handle.resetSelection(to: entry.override)
        _handle = State(initialValue: handle)
    }

    var body: some View {
        let editing = draft != nil
        let dirty = draft.map { Prompts.promptDraftDirty(entry, draft: $0) } ?? false
        let liveError = draft.flatMap { Prompts.promptDraftError(entry, draft: $0) }
        let errorLine = Prompts.promptErrorLine(entry, draft: draft, serverError: serverError)
        let state = Prompts.promptState(entry)
        let canSave = editing && dirty && liveError == nil && !saving
        let cancellable = dirty || (editing && entry.override == nil)
        let insertable = editing && !compare

        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        PromptBadge(entry: entry)
                        if saving { Spinner() }
                    }
                    Text(entry.description).font(.scaled(size: 14)).foregroundStyle(c.text2)
                }

                if state == .broken {
                    Callout(tone: .red, icon: "alert", title: Prompts.State.broken.label, message: Prompts.brokenOverrideMessage(entry))
                }

                // Above the text: a built-in prompt can run to a few screens.
                if !editing || entry.override != nil {
                    HStack(spacing: 8) {
                        if !editing {
                            HButton("Customize", icon: "edit", variant: .primary, fullWidth: false) { setAppDraft(Prompts.promptStartText(entry)) }
                        }
                        if entry.override != nil {
                            HButton("Reset to built-in", icon: "refresh", variant: .danger, fullWidth: false, action: reset)
                                .disabled(saving)
                        }
                    }
                }

                if editing {
                    PromptSegmented(compare: compare) { v in
                        compare = v
                        handle.blur()
                    }
                }

                // Above the field, so it stays in view while editing a prompt that runs to a few screens.
                if let errorLine { Callout(tone: .red, icon: "alert", message: errorLine) }

                if let draft {
                    if compare {
                        PromptDiffView(from: entry.builtin, to: draft)
                    } else {
                        PromptTextEditor(text: Binding(get: { self.draft ?? "" }, set: change), handle: handle, textColor: UIColor(c.text), accessibilityLabel: "\(entry.label) prompt")
                            .background(c.bgElev, in: .rect(cornerRadius: 12))
                            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(errorLine != nil ? c.red : c.border, lineWidth: 0.5) }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("BUILT-IN TEXT · READ-ONLY").font(.scaled(size: 12, weight: .semibold)).foregroundStyle(c.text3)
                        Text(entry.builtin)
                            .font(.mono(13))
                            .foregroundStyle(c.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("\(entry.label) prompt")
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
                    .background(c.bgElev, in: .rect(cornerRadius: 12))
                    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 0.5) }
                }

                Text(editing
                    ? "A customized prompt doesn't pick up built-in improvements from app updates. Reset it to follow the built-in again. Leaving it empty, or the same as the built-in, saves it as built-in."
                    : "Built-in: this text improves with app updates while the prompt isn't customized.")
                    .font(.scaled(size: 13))
                    .foregroundStyle(c.text3)

                if !entry.variables.isEmpty { variables(insertable: insertable) }
            }
            .padding(16)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(c.bg)
        .navigationTitle(entry.label)
        .navigationBarBackButtonHidden(cancellable)
        .toolbar {
            if cancellable {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", systemImage: "xmark", action: cancel)
                        .keyboardShortcut(.cancelAction)
                }
            }
            if editing {
                ToolbarItem(placement: .topBarTrailing) {
                    // Disabled, a prominent glass button still reads as enabled in dark mode, so it goes plain and dim.
                    if canSave {
                        // ⌘S, as on the desktop.
                        Button("Save", systemImage: "checkmark") { submit() }.buttonStyle(.glassProminent).tint(c.accent)
                            .keyboardShortcut("s")
                    } else {
                        Button("Save", systemImage: "checkmark") {}.disabled(true)
                    }
                }
            }
        }
        .confirmation($confirm)
        // Another client saved or reset this prompt: follow it unless there are edits to keep.
        .onChange(of: entry.override) { _, override in
            if !(draft.map { Prompts.promptDraftDirty(entry, draft: $0) } ?? false) { setAppDraft(override) }
        }
    }

    private func variables(insertable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Variables")
            Card {
                ForEach(Array(entry.variables.enumerated()), id: \.element.name) { i, v in
                    if i > 0 { Divider().overlay(c.border) }
                    // Only an editor takes an insert; otherwise the row is plain text, not a dead button.
                    if insertable {
                        Button { insertVar(v.name) } label: { variableRow(v, insertable: true) }
                            .buttonStyle(.plain)
                    } else {
                        variableRow(v, insertable: false)
                            .accessibilityElement(children: .combine)
                    }
                }
            }
            (Text("{{#if name}} … {{else}} … {{/if}}").font(.mono(12))
                + Text(" includes text only when a variable is set (true or not empty).\(insertable ? " Tap a variable to insert it at the cursor." : "")"))
                .font(.scaled(size: 13))
                .foregroundStyle(c.text3)
                .padding(.horizontal, 4)
        }
    }

    private func variableRow(_ v: PromptVariable, insertable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("{{\(v.name)}}").font(.mono(14)).foregroundStyle(insertable ? c.accent : c.text)
            Text(v.description).font(.scaled(size: 13)).foregroundStyle(c.text3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(.rect)
    }

    /// Text the app puts in (Customize, Cancel, a reset, another client's save): the cursor goes to its end.
    private func setAppDraft(_ text: String?) {
        draft = text
        handle.resetSelection(to: text)
    }

    private func change(_ text: String) {
        draft = text
        serverError = nil
    }

    private func save(_ value: String?, message: String) {
        guard let api = store.api else { return }
        let patch = Prompts.promptSavePatch(entry, draft: value)
        saving = true
        serverError = nil
        Task {
            do {
                _ = try await api.updateSettings(patch)
                if (patch.prompts?[entry.id.rawValue] ?? nil) == nil { setAppDraft(nil) }
                toasts.show(message, kind: .info)
                await catalog.load()
            } catch {
                // Keep the text: the service's 400 says what to fix.
                haptic(.error)
                serverError = localizedErrorMessage(error)
            }
            saving = false
        }
    }

    private func submit() {
        guard let draft, Prompts.promptDraftDirty(entry, draft: draft), Prompts.promptDraftError(entry, draft: draft) == nil, !saving else { return }
        let resets = (Prompts.promptSavePatch(entry, draft: draft).prompts?[entry.id.rawValue] ?? nil) == nil
        save(draft, message: resets ? "Prompt reset to built-in" : "Prompt saved")
    }

    private func cancel() {
        serverError = nil
        compare = false
        setAppDraft(entry.override)
        handle.blur()
    }

    private func reset() {
        confirm = Confirmation(title: "Reset “\(entry.label)” to the built-in prompt?", message: "Your text is discarded, and the prompt follows app updates again.", action: "Reset") {
            save(nil, message: "Prompt reset to built-in")
        }
    }

    private func insertVar(_ name: String) {
        guard let draft else { return }
        let sel = handle.selection
        let next = Prompts.insertText(draft, start: sel.location, end: sel.location + sel.length, insert: "{{\(name)}}")
        change(next.text)
        // The new value lands natively on the next frame; then the caret goes right after the
        // insert, where the next insert (and the next keystroke) expects it.
        handle.focus(caret: next.caret)
    }
}

/// Edit / Compare with built-in. Two buttons drawn as a segmented control rather
/// than a segmented Picker, whose segments AXe doesn't list by label (sim-check waits for
/// "Compare with built-in").
private struct PromptSegmented: View {
    let compare: Bool
    let onChange: (Bool) -> Void

    @Environment(\.palette) private var c

    var body: some View {
        HStack(spacing: 2) {
            segment("Edit", selected: !compare) { onChange(false) }
            segment("Compare with built-in", selected: compare) { onChange(true) }
        }
        .padding(2)
        .background(c.bgSunken, in: .capsule)
    }

    private func segment(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button {
            if !selected {
                haptic(.select)
                action()
            }
        } label: {
            Text(label)
                .font(.scaled(size: 14, weight: selected ? .semibold : .regular))
                .foregroundStyle(c.text)
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 32)
                .background(selected ? c.bgElev : .clear, in: .capsule)
                .shadow(color: selected ? .black.opacity(0.08) : .clear, radius: 2, y: 1)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The draft against the built-in, line by line: + green, − red.
private struct PromptDiffView: View {
    let from: String
    let to: String

    @Environment(\.palette) private var c

    var body: some View {
        let lines = Prompts.lineDiff(from: from, to: to)
        let add = c.tone(.green)
        let del = c.tone(.red)
        VStack(alignment: .leading, spacing: 0) {
            if !lines.contains(where: { $0.type != .same }) {
                Text("Same as the built-in.").font(.scaled(size: 13)).foregroundStyle(c.text3).padding(.horizontal, 12).padding(.bottom, 6)
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                Text((l.type == .add ? "+ " : l.type == .del ? "− " : "  ") + l.text)
                    .font(.mono(12))
                    .foregroundStyle(l.type == .same ? c.text2 : l.type == .add ? add.fg : del.fg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 1)
                    .background(l.type == .same ? Color.clear : l.type == .add ? add.bg : del.bg)
            }
        }
        .textSelection(.enabled)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
        .background(c.bgElev, in: .rect(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 0.5) }
    }
}
