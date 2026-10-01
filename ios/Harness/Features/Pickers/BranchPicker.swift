import HarnessKit
import SwiftUI

/// A project's branch, searchable, or a new one (ui/BranchPicker.tsx on Branches.branchRows). Same
/// trigger as the other selects; it opens a page sheet with a search field over the project's
/// branches (GET /projects/:id/branches?q=, debounced): the default first, then the matches, then
/// the typed name (a new branch, or why git won't take it).
///
/// nil = the default (`defaultLabel`, e.g. "New branch harness/web-4"); `newLabel` labels a typed
/// name the list doesn't have ("Create x from main"). `onChange` gets the picked row's entry so the
/// caller can hint at checkedOutAt.
struct BranchPicker: View {
    let projectId: String
    let value: String?
    let defaultLabel: String
    let newLabel: (String) -> String
    var title = "Branch"
    var disabled = false
    let onChange: (String?, BranchInfo?) -> Void

    @State private var open = false

    var body: some View {
        let label = value ?? defaultLabel
        Button {
            open = true
        } label: {
            SelectTrigger(text: label, disabled: disabled, mono: value != nil, chevron: !disabled)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(label)")
        .accessibilityAddTraits(.isButton)
        .sheet(isPresented: $open) {
            BranchSheet(title: title, projectId: projectId, picked: value, defaultLabel: defaultLabel, newLabel: newLabel) { row in
                if case .invalid = row { return }
                haptic(.select)
                open = false
                guard row.value != value else { return }
                if case let .branch(info) = row { onChange(row.value, info) } else { onChange(row.value, nil) }
            }
        }
    }
}

/// The sheet: a mono search field (focused on open; Return picks the first row) over the rows.
private struct BranchSheet: View {
    static let debounce: Duration = .milliseconds(150)

    let title: String
    let projectId: String
    let picked: String?
    let defaultLabel: String
    let newLabel: (String) -> String
    let onPick: (BranchRow) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @State private var query = ""
    @State private var matches: [BranchInfo] = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        let rows = Branches.branchRows(matches, query: query, defaultLabel: defaultLabel, newLabel: newLabel)
        PickerSheet(
            title: title,
            query: $query,
            placeholder: "Search or name a new branch",
            searchLabel: "Search branches",
            mono: true,
            autofocus: true,
            problem: error.map { "Couldn't list branches: \($0)" },
            submitLabel: .done,
            onSubmit: { if let first = rows.first(where: { Branches.rowId($0) != nil }) { onPick(first) } }
        ) {
            if loading { ProgressView() }
        } content: {
            List {
                ForEach(rows, id: \.listId) { row in
                    rowView(row)
                }
            }
            .overlay {
                if rows.isEmpty && !loading {
                    Text("No branches match").font(.system(size: 15)).foregroundStyle(c.text3)
                }
            }
        }
        .task(id: "\(query)#\(store.epoch)") { await search() }
    }

    @ViewBuilder private func rowView(_ row: BranchRow) -> some View {
        switch row {
        case let .invalid(label):
            HStack(spacing: 10) {
                Icon("alert", size: 15).foregroundStyle(c.red)
                Text(label).font(.system(size: 14)).foregroundStyle(c.red)
            }
            .listRowBackground(c.bgElev)
            .accessibilityElement(children: .combine)
        case let .branch(info):
            let where_ = info.checkedOutAt.flatMap { $0.isEmpty ? nil : Format.tildify($0) }
            PickerSheetRow(
                label: row.label,
                mono: true,
                selected: row.value == picked,
                accessibilityLabel: where_.map { "\(row.label), checked out in \($0)" } ?? row.label,
                action: { onPick(row) },
                leading: { Icon("branch", size: 15).foregroundStyle(c.text3) },
                subtitle: {
                    Text(where_.map { "Checked out in \($0)" } ?? "Last commit \(Format.relativeTime(info.lastCommitAt))")
                        .font(.system(size: 12.5))
                        .foregroundStyle(where_ != nil ? c.amber : c.text3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            )
        case .default, .new:
            PickerSheetRow(
                label: row.label,
                titleColor: c.accentText,
                mono: true,
                selected: row.value == picked,
                action: { onPick(row) },
                leading: { Icon("plus", size: 15).foregroundStyle(c.accent) },
                subtitle: { EmptyView() }
            )
        }
    }

    /// `useBranchSearch`: re-fetch (debounced) as the query changes; a newer query cancels this one.
    private func search() async {
        guard !projectId.isEmpty, let client = store.pickerClient else { return }
        loading = true
        do {
            try await Task.sleep(for: Self.debounce)
            let list = try await client.projectBranches(projectId, q: query.trimmingCharacters(in: .whitespacesAndNewlines), limit: nil)
            try Task.checkCancellation()
            matches = list
            error = nil
            loading = false
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled { return }
            self.error = pickerErrorMessage(error)
            loading = false
        }
    }
}

private extension BranchRow {
    /// A stable list id: the kind and the name.
    var listId: String { "\(kind):\(value ?? "")" }
}
