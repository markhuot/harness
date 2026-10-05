import HarnessKit
import SwiftUI

/// A project's group (project settings), on ProjectGroups.rows like the Mac's GroupSelect. Same
/// trigger as the other selects; it opens a page sheet whose field filters the groups other
/// projects have and names a new one: the matching groups, best match first, then No group and
/// `New group "<name>"` when no group has the typed name in any case. Return picks the first row,
/// the best match (ProjectGroups.submitRow), as Enter does on the Mac.
///
/// nil = no group. `groups` is every group in use, alphabetically (BoardState.projectGroups).
struct GroupPicker: View {
    let value: String?
    let groups: [String]
    let onChange: (String?) -> Void

    @State private var open = false

    var body: some View {
        let label = value ?? ProjectGroups.noGroupLabel
        Button {
            open = true
        } label: {
            SelectTrigger(text: label)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Group, \(label)")
        .accessibilityAddTraits(.isButton)
        .sheet(isPresented: $open) {
            GroupSheet(picked: value, groups: groups) { row in
                guard row != .invalid else { return }
                haptic(.select)
                open = false
                if row.value != value { onChange(row.value) }
            }
        }
    }
}

/// The sheet: a field (focused on open) over the rows.
private struct GroupSheet: View {
    let picked: String?
    let groups: [String]
    let onPick: (GroupRow) -> Void

    @Environment(\.palette) private var c
    @State private var query = ""
    @State private var latest = PickerLatest<(rows: [GroupRow], query: String, pick: (GroupRow) -> Void)>()

    var body: some View {
        let rows = ProjectGroups.rows(groups, query: query)
        let _ = latest.set((rows, query, onPick))
        PickerSheet(
            title: "Group",
            query: $query,
            placeholder: "Search or name a new group",
            searchLabel: "Search groups",
            autofocus: true,
            submitLabel: .done,
            // Read the rows when Return fires: the field keeps an earlier closure.
            onSubmit: {
                guard let l = latest.value, let row = ProjectGroups.submitRow(l.rows, query: l.query) else { return }
                l.pick(row)
            }
        ) {
            EmptyView()
        } content: {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.listId) { i, row in
                        if i > 0 { Rectangle().fill(c.border).frame(height: 1 / 3).padding(.leading, 41) }
                        rowView(row)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 11)
                            .frame(minHeight: 50)
                    }
                }
                .background(c.bgElev, in: .rect(cornerRadius: 26))
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    @ViewBuilder private func rowView(_ row: GroupRow) -> some View {
        switch row {
        case .invalid:
            HStack(spacing: 10) {
                Icon("alert", size: 15).foregroundStyle(c.red)
                Text(row.label).font(.scaled(size: 14)).foregroundStyle(c.red)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        case .none:
            PickerSheetRow(
                label: row.label, selected: picked == nil, action: { onPick(row) },
                leading: { Icon("x", size: 15).foregroundStyle(c.text3) },
                subtitle: { EmptyView() })
        case .group:
            PickerSheetRow(
                label: row.label, selected: row.value == picked, action: { onPick(row) },
                leading: { Icon("folder", size: 15).foregroundStyle(c.text3) },
                subtitle: { EmptyView() })
        case .new:
            PickerSheetRow(
                label: row.label, titleColor: c.accentText, selected: false, action: { onPick(row) },
                leading: { Icon("plus", size: 15).foregroundStyle(c.accent) },
                subtitle: { EmptyView() })
        }
    }
}

private extension GroupRow {
    /// A stable list id: the kind and the name.
    var listId: String {
        switch self {
        case .none: "none"
        case let .group(g): "group:\(g)"
        case let .new(g): "new:\(g)"
        case .invalid: "invalid"
        }
    }
}
