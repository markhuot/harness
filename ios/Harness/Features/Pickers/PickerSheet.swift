import HarnessKit
import SwiftUI

/// The page sheet behind the searchable pickers (model, branch): Cancel, the title, a trailing
/// accessory (refresh / spinner), a search field pinned under the bar with an optional problem
/// line, and the list. The search field is our own rather than `.searchable` so it can be mono
/// (branches), focus on open, and carry the AX label sim-check looks for.
struct PickerSheet<Content: View, Trailing: View>: View {
    let title: String
    @Binding var query: String
    let placeholder: String
    let searchLabel: String
    var mono = false
    var autofocus = false
    var problem: String?
    var submitLabel: SubmitLabel = .search
    var onSubmit: () -> Void = {}
    @ViewBuilder var trailing: Trailing
    @ViewBuilder var content: Content

    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var c
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            searchBar
            content
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .scrollDismissesKeyboard(.immediately)
        }
        .background(c.bg)
        .presentationDetents([.large])
        .onAppear { if autofocus { focused = true } }
    }

    /// Cancel, the title and the accessory in the sheet itself: AXe doesn't see a
    /// sheet's toolbar items, and sim-check taps "Cancel" by label.
    private var header: some View {
        HStack(spacing: 10) {
            Button("Cancel") { dismiss() }
                .font(.scaled(size: 16))
                .foregroundStyle(c.accent)
                .frame(width: 72, alignment: .leading)
            Text(title)
                .font(.scaled(size: 16, weight: .semibold))
                .foregroundStyle(c.text)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            trailing
                .foregroundStyle(c.accent)
                .labelStyle(.iconOnly)
                .frame(width: 72, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    private var searchBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(c.text3)
                TextField("", text: $query, prompt: Text(placeholder).foregroundStyle(c.text3))
                    .font(mono ? .mono(16) : .scaled(size: 16))
                    .foregroundStyle(c.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(submitLabel)
                    .focused($focused)
                    .onSubmit(onSubmit)
                    .accessibilityLabel(searchLabel)
                if !query.isEmpty {
                    Button("Clear", systemImage: "xmark.circle.fill") { query = "" }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(c.text3)
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(c.bgElev, in: RoundedRectangle(cornerRadius: 10))
            if let problem {
                Text(problem).font(.scaled(size: 13)).foregroundStyle(c.amber)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 10)
        .background(c.bg)
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
    }
}

/// A row in a picker sheet: icon, title (and subtitle), and the check on the current pick.
struct PickerSheetRow<Leading: View, Subtitle: View>: View {
    let label: String
    var titleColor: Color?
    var mono = false
    let selected: Bool
    var accessibilityLabel: String?
    let action: () -> Void
    @ViewBuilder var leading: Leading
    @ViewBuilder var subtitle: Subtitle

    @Environment(\.palette) private var c

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                leading
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(mono ? .mono(15) : .scaled(size: 16))
                        .foregroundStyle(titleColor ?? c.text)
                        .lineLimit(2)
                    subtitle
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(c.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(c.bgElev)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel ?? label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
