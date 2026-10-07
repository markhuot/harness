import HarnessKit
import SwiftUI

/// A multiline editor with `@file` mentions and `/command` completion (on
/// Logic/Mentions, Commands and MentionCaret). Typing `@fo` lists matching files and folders, and
/// tapping one completes it; picking a folder keeps the list open inside it. A /command or skill
/// that starts the text completes the same way. The service attaches mentioned files to the
/// agent's prompt; the agent expands commands itself.
///
/// The field is uncontrolled while it's being typed in: it keeps its own copy of the text (`buffer`)
/// and draws in `MentionField`, an Equatable view that redraws only when its own inputs change. A
/// parent redrawing (a save coming back, any socket event) never sets the text view's text or
/// selection, which would cancel an autocorrection or inline prediction iOS is showing and rewrite
/// what's under the caret. Typing goes out to `text`; `text` comes back into the field only when it
/// changes to something the field didn't type (a send clearing it, another device's draft).
///
/// The lookups search the ticket's folder (`ticketKey`: ticketFiles/ticketCommands) or the
/// project's (`projectId`: projectFiles/projectCommands for `commandDriver`), unless the caller
/// passes its own `search`/`searchCommands`. `suggestionsEdge` puts the list above the field for a
/// composer pinned to the bottom (the keyboard pushes both up together) or below it in a form.
struct MentionTextEditor: View {
    static let debounce: Duration = .milliseconds(80)

    @Binding var text: String
    var placeholder = ""
    var projectId: String?
    var ticketKey: String?
    /// The field is at least this many lines tall before it grows. The text view itself takes the
    /// height (not a frame around it), so a tap or a drag anywhere in it places the caret.
    var minLines = 4
    /// The driver whose commands a project lookup lists (New session: the driver it will run with)
    var commandDriver: String?
    /// Complete leading /commands too
    var commands = true
    /// The field grows a line at a time up to this many, then scrolls inside itself (nil: it keeps
    /// growing, for a field in a form that scrolls)
    var maxLines: Int? = 12
    /// Scroll the enclosing form or scroll view so the cursor stays in sight above the keyboard as
    /// the text grows or the cursor moves (an uncapped `maxLines` field in a form)
    var followsCaret = false
    var suggestionsEdge: VerticalEdge = .bottom
    var suggestionsMaxHeight: CGFloat = 220
    /// Draw the field in its own rounded box (off when the caller's container already is one)
    var boxed = true
    var search: (@Sendable (String) async throws -> [FileMatch])?
    var searchCommands: (@Sendable (String) async throws -> [CommandMatch])?
    /// The field's accessibility label when it isn't the placeholder (a composer whose placeholder
    /// changes with the ticket's state keeps one label)
    var fieldLabel: String?
    /// The placeholder's color (default: the theme's muted text)
    var placeholderColor: Color?
    /// Called when the field gains or loses focus
    var onFocusChange: ((Bool) -> Void)?
    /// A box of the caller's own (the ticket composer's pill) instead of the default one; wins over `boxed`
    var fieldBox: MentionFieldBox?
    /// Focus the field when it appears (New session's prompt)
    var autofocus = false
    /// Focus the field each time this changes (the composer once an annotated image joins it)
    var focusRequest = 0
    /// ⌘↩ while the field has focus (the composer's Send)
    var onSubmit: (() -> Void)?

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @FocusState private var focused: Bool
    @State private var caret = MentionCaret.none
    @State private var selection: TextSelection?
    @State private var items: [MentionItem] = []
    /// The field's own text (nil until it's typed in or told otherwise: `text` until then)
    @State private var buffer: String?
    /// Bumped when the field has to take a text or selection it didn't make itself
    @State private var revision = 0

    /// What the field shows.
    private var current: String { buffer ?? text }

    var body: some View {
        let value = current
        let target = PickerLogic.mentionTarget(value, caret: caret, commands: commands)
        let shown = target == nil ? [] : items
        VStack(spacing: 8) {
            if suggestionsEdge == .top { suggestions(shown, target: target) }
            field
            if suggestionsEdge == .bottom { suggestions(shown, target: target) }
        }
        .task(id: target?.lookup) { await lookup(target) }
        .onChange(of: selection) { _, sel in
            if followsCaret, focused, let v = FocusedTextView.current() { PromptTextEditor.followCaret(v) }
            guard let range = Self.range(sel) else { return }
            caret = caret.onSelection(start: PickerLogic.utf16Offset(range.lowerBound, in: value), end: PickerLogic.utf16Offset(range.upperBound, in: value))
        }
        .onChange(of: text) { _, next in
            // Typing comes back as what the field already has; anything else came from outside.
            if let buffer, next.unicodeScalars.elementsEqual(buffer.unicodeScalars) { return }
            buffer = next
            revision += 1
        }
        .onChange(of: focused) { _, now in onFocusChange?(now) }
    }

    private var field: some View {
        EquatableView(content: MentionField(
            text: Binding(get: { buffer ?? text }, set: { next in
                buffer = next
                text = next
            }),
            selection: $selection,
            focused: $focused,
            shown: current,
            revision: revision,
            placeholder: placeholder,
            placeholderColor: placeholderColor,
            minLines: minLines,
            maxLines: maxLines,
            boxed: boxed,
            fieldBox: fieldBox,
            fieldLabel: fieldLabel,
            autofocus: autofocus,
            focusRequest: focusRequest
        ))
        // Out here, not in MentionField: the Equatable field would keep an old closure.
        .onSubmitShortcut(onSubmit)
    }

    @ViewBuilder private func suggestions(_ shown: [MentionItem], target: MentionTarget?) -> some View {
        if !shown.isEmpty {
            let rowHeight: CGFloat = 41
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { i, item in
                        MentionSuggestionRow(item: item, divider: i > 0) { pick(item, target: target) }
                    }
                }
            }
            .frame(height: min(CGFloat(shown.count) * rowHeight, suggestionsMaxHeight))
            .background(c.bgElev)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
            // No container label ("Commands"/"Files"): a labeled container is one element
            // to AXe, which then hides the rows sim-check taps (ARCHITECTURE § Accessibility labels).
        }
    }

    private func pick(_ item: MentionItem, target: MentionTarget?) {
        guard let target, let next = PickerLogic.pickMention(current, target: target, item: item) else { return }
        haptic(.select)
        let before = caret.at
        buffer = next.text
        revision += 1
        text = next.text
        caret = MentionCaret.onPick(next.caret, before: before)
        selection = TextSelection(insertionPoint: PickerLogic.index(utf16: next.caret, in: next.text))
    }

    /// The debounced lookup for what's typed; a newer target cancels this one (`live = false`).
    private func lookup(_ target: MentionTarget?) async {
        guard let target else {
            items = []
            return
        }
        do {
            try await Task.sleep(for: Self.debounce)
            let found: [MentionItem]
            if target.isCommand {
                found = try await commandLookup(target.query).map(MentionItem.command)
            } else {
                found = try await fileLookup(target.query).map(MentionItem.file)
            }
            try Task.checkCancellation()
            items = found
        } catch is CancellationError {
            return
        } catch {
            if !Task.isCancelled { items = [] }
        }
    }

    private func fileLookup(_ q: String) async throws -> [FileMatch] {
        if let search { return try await search(q) }
        guard let client = store.pickerClient else { return [] }
        if let ticketKey { return try await client.ticketFiles(ticketKey, q: q, FileSearchOptions()) }
        if let projectId { return try await client.projectFiles(projectId, q: q, FileSearchOptions()) }
        return []
    }

    private func commandLookup(_ q: String) async throws -> [CommandMatch] {
        if let searchCommands { return try await searchCommands(q) }
        guard let client = store.pickerClient else { return [] }
        if let ticketKey { return try await client.ticketCommands(ticketKey, q: q, limit: nil) }
        if let projectId { return try await client.projectCommands(projectId, q: q, driver: commandDriver, limit: nil) }
        return []
    }

    private static func range(_ sel: TextSelection?) -> Range<String.Index>? {
        guard let sel else { return nil }
        switch sel.indices {
        case let .selection(range): return range
        case .multiSelection: return nil
        @unknown default: return nil
        }
    }
}

/// MentionTextEditor's text field. Equatable on everything but its bindings, so a parent redrawing
/// with the same look leaves the text view alone (see MentionTextEditor); `revision` redraws it when
/// the editor hands it a text or selection it didn't type.
///
/// `shown` (the editor's buffer) redraws it after typing too. TextField keeps the text it was last
/// drawn with and writes it back over the field when the caret moves, so a field left undrawn since
/// it was empty would empty itself on the first tap that moves the caret.
private struct MentionField: View, Equatable {
    let text: Binding<String>
    let selection: Binding<TextSelection?>
    let focused: FocusState<Bool>.Binding
    let shown: String
    let revision: Int
    let placeholder: String
    let placeholderColor: Color?
    let minLines: Int
    let maxLines: Int?
    let boxed: Bool
    let fieldBox: MentionFieldBox?
    let fieldLabel: String?
    let autofocus: Bool
    let focusRequest: Int

    @Environment(\.palette) private var c

    nonisolated static func == (a: MentionField, b: MentionField) -> Bool {
        a.revision == b.revision && a.shown.unicodeScalars.elementsEqual(b.shown.unicodeScalars) && a.placeholder == b.placeholder && a.placeholderColor == b.placeholderColor
            && a.minLines == b.minLines && a.maxLines == b.maxLines && a.boxed == b.boxed && a.fieldBox == b.fieldBox
            && a.fieldLabel == b.fieldLabel && a.autofocus == b.autofocus && a.focusRequest == b.focusRequest
    }

    var body: some View {
        TextField("", text: text, selection: selection, prompt: Text(placeholder).foregroundStyle(placeholderColor ?? c.text3), axis: .vertical)
            .font(.scaled(size: 17))
            // On a vertical field the range is how tall it starts and how far it grows before
            // scrolling (no upper bound: no limit).
            .lineLimit(minLines...(maxLines.map { max($0, minLines) } ?? .max))
            .padding(fieldBox?.padding ?? EdgeInsets(top: boxed ? 12 : 0, leading: boxed ? 12 : 0, bottom: boxed ? 12 : 0, trailing: boxed ? 12 : 0))
            .background {
                if let box = fieldBox {
                    if box.glass {
                        Color.clear.glassEffect(.regular.interactive(), in: .rect(cornerRadius: box.cornerRadius))
                    } else {
                        RoundedRectangle(cornerRadius: box.cornerRadius).fill(box.fill)
                    }
                    if let border = box.border {
                        RoundedRectangle(cornerRadius: box.cornerRadius).strokeBorder(border)
                    }
                } else if boxed {
                    RoundedRectangle(cornerRadius: 12).fill(c.bgElev)
                    RoundedRectangle(cornerRadius: 12).strokeBorder(c.border)
                }
            }
            .focused(focused)
            .accessibilityLabel(fieldLabel ?? placeholder)
            .task(id: focusRequest) {
                guard focusRequest > 0 else { return }
                // After the annotator's cover has gone.
                try? await Task.sleep(for: .milliseconds(450))
                focused.wrappedValue = true
            }
            .task {
                guard autofocus else { return }
                // A sheet's field takes focus once the sheet has finished sliding up.
                try? await Task.sleep(for: .milliseconds(350))
                focused.wrappedValue = true
            }
    }
}

/// The field's box when the caller draws its own (MentionTextEditor `fieldBox`).
struct MentionFieldBox: Equatable {
    var fill: Color = .clear
    /// nil draws no border
    var border: Color?
    var cornerRadius: CGFloat
    var padding: EdgeInsets
    /// Liquid Glass in place of `fill`
    var glass = false
}

/// One row of the list: icon, name, then the folder (cut at its start) or the command's description.
private struct MentionSuggestionRow: View {
    let item: MentionItem
    let divider: Bool
    let action: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        let row = PickerLogic.mentionRow(item)
        Button(action: action) {
            HStack(spacing: 8) {
                Icon(row.icon, size: 15).foregroundStyle(c.text3)
                Text(row.name).font(.mono(14)).foregroundStyle(c.text).lineLimit(1).layoutPriority(1)
                if !row.detail.isEmpty {
                    Text(row.detail)
                        .font(.scaled(size: 12.5))
                        .foregroundStyle(c.text3)
                        .lineLimit(1)
                        .truncationMode(row.truncateHead ? .head : .tail)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 41)
            .contentShape(Rectangle())
            .overlay(alignment: .top) { if divider { Rectangle().fill(c.border).frame(height: 1 / 3) } }
        }
        .buttonStyle(MentionRowStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.label)
        .accessibilityAddTraits(.isButton)
    }
}

private struct MentionRowStyle: ButtonStyle {
    @Environment(\.palette) private var c

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? c.bgActive : .clear)
    }
}
