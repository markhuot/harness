import HarnessKit
import SwiftUI

/// A multiline editor with `@file` mentions and `/command` completion (ui/mentions.tsx on
/// Logic/Mentions, Commands and MentionCaret). Typing `@fo` lists matching files and folders, and
/// tapping one completes it; picking a folder keeps the list open inside it. A /command or skill
/// that starts the text completes the same way. The service attaches mentioned files to the
/// agent's prompt; the agent expands commands itself.
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
    var minHeight: CGFloat = 80
    /// The driver whose commands a project lookup lists (New session: the driver it will run with)
    var commandDriver: String?
    /// Complete leading /commands too
    var commands = true
    var maxLines = 12
    var suggestionsEdge: VerticalEdge = .bottom
    var suggestionsMaxHeight: CGFloat = 220
    /// Draw the field in its own rounded box (off when the caller's container already is one)
    var boxed = true
    var search: (@Sendable (String) async throws -> [FileMatch])?
    var searchCommands: (@Sendable (String) async throws -> [CommandMatch])?

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @State private var caret = MentionCaret.none
    @State private var selection: TextSelection?
    @State private var items: [MentionItem] = []

    var body: some View {
        let target = PickerLogic.mentionTarget(text, caret: caret, commands: commands)
        let shown = target == nil ? [] : items
        VStack(spacing: 8) {
            if suggestionsEdge == .top { suggestions(shown, target: target) }
            field
            if suggestionsEdge == .bottom { suggestions(shown, target: target) }
        }
        .task(id: target?.lookup) { await lookup(target) }
    }

    private var field: some View {
        TextField("", text: $text, selection: $selection, prompt: Text(placeholder).foregroundStyle(c.text3), axis: .vertical)
            .font(.system(size: 16))
            .foregroundStyle(c.text)
            .lineLimit(1...maxLines)
            .frame(minHeight: minHeight, alignment: .topLeading)
            .padding(boxed ? 12 : 0)
            .background {
                if boxed {
                    RoundedRectangle(cornerRadius: 12).fill(c.bgElev)
                    RoundedRectangle(cornerRadius: 12).strokeBorder(c.border)
                }
            }
            .onChange(of: selection) { _, sel in
                guard let range = Self.range(sel) else { return }
                caret = caret.onSelection(start: PickerLogic.utf16Offset(range.lowerBound, in: text), end: PickerLogic.utf16Offset(range.upperBound, in: text))
            }
            .accessibilityLabel(placeholder)
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
            .accessibilityElement(children: .contain)
            .accessibilityLabel(shown.first.map { if case .command = $0 { "Commands" } else { "Files" } } ?? "Files")
        }
    }

    private func pick(_ item: MentionItem, target: MentionTarget?) {
        guard let target, let next = PickerLogic.pickMention(text, target: target, item: item) else { return }
        haptic(.select)
        let before = caret.at
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
                        .font(.system(size: 12.5))
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
