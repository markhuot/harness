import HarnessKit
import SwiftUI

/// The page sheet behind the searchable pickers (model, branch): Cancel (or another `leading`
/// control), the title, a trailing accessory (refresh / spinner), a search field pinned under the bar with an optional problem
/// line, and the list. The search field is our own rather than `.searchable` so it can be mono
/// (branches), focus on open, and carry the AX label sim-check looks for.
struct PickerSheet<Content: View, Leading: View, Trailing: View>: View {
    let title: String
    @Binding var query: String
    let placeholder: String
    let searchLabel: String
    var mono = false
    var autofocus = false
    var problem: String?
    var submitLabel: SubmitLabel = .search
    var onSubmit: () -> Void = {}
    let leading: Leading
    let trailing: Trailing
    let content: Content

    init(
        title: String,
        query: Binding<String>,
        placeholder: String,
        searchLabel: String,
        mono: Bool = false,
        autofocus: Bool = false,
        problem: String? = nil,
        submitLabel: SubmitLabel = .search,
        onSubmit: @escaping () -> Void = {},
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self._query = query
        self.placeholder = placeholder
        self.searchLabel = searchLabel
        self.mono = mono
        self.autofocus = autofocus
        self.problem = problem
        self.submitLabel = submitLabel
        self.onSubmit = onSubmit
        self.leading = leading()
        self.trailing = trailing()
        self.content = content()
    }

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

    /// The leading control, the title and the trailing accessory in the sheet itself: AXe doesn't
    /// see a sheet's toolbar items, and sim-check taps them by label.
    private var header: some View {
        HStack(spacing: 10) {
            leading
                .foregroundStyle(c.accent)
                .labelStyle(.iconOnly)
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

/// The default leading control: Cancel, which dismisses the sheet.
struct PickerCancelButton: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Button("Cancel") { dismiss() }.font(.scaled(size: 16))
    }
}

extension PickerSheet where Leading == PickerCancelButton {
    /// A sheet whose leading control is Cancel.
    init(
        title: String,
        query: Binding<String>,
        placeholder: String,
        searchLabel: String,
        mono: Bool = false,
        autofocus: Bool = false,
        problem: String? = nil,
        submitLabel: SubmitLabel = .search,
        onSubmit: @escaping () -> Void = {},
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) {
        self.init(
            title: title, query: query, placeholder: placeholder, searchLabel: searchLabel, mono: mono, autofocus: autofocus,
            problem: problem, submitLabel: submitLabel, onSubmit: onSubmit, leading: { PickerCancelButton() }, trailing: trailing, content: content
        )
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
