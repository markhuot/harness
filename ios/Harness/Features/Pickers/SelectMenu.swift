import HarnessKit
import SwiftUI

// The desktop's <select>s as native pull-down menus (ui/selects.tsx): a Menu whose label shows the
// current value with the ⌃⌄ select glyph. Each option is a Toggle, which a menu draws as a
// checkmark item; `isOn` comes from `value` alone, so the menu never shows a choice the parent
// refused (a disabled driver, a failed save). Actions sit in their own section, headed by the
// problem line when there is one.

/// An action under a select's options ("Refresh model list").
struct SelectMenuAction: Identifiable {
    let label: String
    /// SF Symbol
    var systemImage: String?
    let action: () -> Void

    var id: String { label }
}

/// The trigger every select draws: the value in the accent color, then a spinner, a warning, or
/// the ⌃⌄ glyph. Sheet-backed pickers (model, branch) use it too, so they all look alike.
struct SelectTrigger: View {
    let text: String
    var disabled = false
    var loading = false
    var problem = false
    var mono = false
    var chevron = true

    @Environment(\.palette) private var c

    var body: some View {
        let tint = disabled ? c.text3 : c.accent
        HStack(spacing: 4) {
            Text(text)
                .font(mono ? .mono(15) : .scaled(size: 15))
                .foregroundStyle(tint)
                .lineLimit(1)
                .truncationMode(.middle)
            if loading {
                ProgressView().controlSize(.mini)
            } else if problem {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(c.amber)
            } else if chevron {
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .medium)).foregroundStyle(tint)
            }
        }
        .frame(maxWidth: 280, alignment: .trailing)
        .opacity(disabled ? 0.6 : 1)
        .contentShape(Rectangle())
    }
}

/// A native select. `label` overrides the trigger text (defaults to the selected option's label);
/// `title` heads the option list; `actions` go in their own section below the options.
/// `accessibilityName` prefixes the trigger's AX label ("Model, Sonnet").
struct SelectMenu<Value: Hashable & Sendable>: View {
    let value: Value
    let options: [PickerOption<Value>]
    var label: String?
    var placeholder = "Choose…"
    var title: String?
    var actions: [SelectMenuAction] = []
    var disabled = false
    var loading = false
    var problem: String?
    var accessibilityName: String?
    let onChange: (Value) -> Void

    var body: some View {
        let text = label ?? options.first { $0.value == value }?.label ?? placeholder
        Menu {
            if !options.isEmpty {
                Section {
                    ForEach(options, id: \.value) { option in
                        Toggle(isOn: binding(for: option)) {
                            Text(option.label)
                            if let subtitle = option.subtitle { Text(subtitle) }
                        }
                        .disabled(option.disabled)
                    }
                } header: {
                    if let title { Text(title) }
                }
            }
            if problem != nil || !actions.isEmpty {
                Section {
                    ForEach(actions) { a in
                        if let image = a.systemImage {
                            Button(a.label, systemImage: image, action: a.action)
                        } else {
                            Button(a.label, action: a.action)
                        }
                    }
                } header: {
                    if let problem { Text(problem) }
                }
            }
        } label: {
            SelectTrigger(text: text, disabled: disabled, loading: loading, problem: problem != nil)
        }
        .disabled(disabled)
        .accessibilityLabel(accessibilityName.map { "\($0), \(text)" } ?? text)
    }

    private func binding(for option: PickerOption<Value>) -> Binding<Bool> {
        Binding(
            get: { option.value == value },
            set: { on in
                guard on, !option.disabled, option.value != value else { return }
                haptic(.select)
                onChange(option.value)
            }
        )
    }
}
