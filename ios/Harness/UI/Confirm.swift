import SwiftUI

// Confirms and short action sheets (ui/pick.ts), as state + a modifier, the SwiftUI way:
//
//   @State private var confirm: Confirmation?
//   …
//   Button("Forget") { confirm = Confirmation(title: "Forget this Mac?", message: "…", action: "Forget") { model.forget(id) } }
//   .confirmation($confirm)
//
//   @State private var sheet: ChoiceSheet?
//   .choiceSheet($sheet)

/// An alert with Cancel and one action (RN `confirm(title, message, action, destructive)`).
struct Confirmation: Identifiable {
    let id = UUID()
    var title: String
    var message: String
    var action: String
    var destructive = true
    var onConfirm: @MainActor () -> Void
}

/// One choice in an action sheet (RN `Choice`).
struct Choice: Identifiable {
    let id = UUID()
    var label: String
    var disabled = false
    var destructive = false
    var onPick: @MainActor () -> Void
}

/// An action sheet of choices plus Cancel (RN `pick({ title, message, choices })`).
struct ChoiceSheet: Identifiable {
    let id = UUID()
    var title: String?
    var message: String?
    var choices: [Choice]
    var cancelLabel = "Cancel"
}

extension View {
    func confirmation(_ item: Binding<Confirmation?>) -> some View {
        alert(item.wrappedValue?.title ?? "", isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }), presenting: item.wrappedValue) { c in
            Button("Cancel", role: .cancel) {}
            Button(c.action, role: c.destructive ? .destructive : nil) { c.onConfirm() }
        } message: { c in
            Text(c.message)
        }
    }

    func choiceSheet(_ item: Binding<ChoiceSheet?>) -> some View {
        confirmationDialog(item.wrappedValue?.title ?? "", isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }),
                           titleVisibility: item.wrappedValue?.title == nil ? .hidden : .visible, presenting: item.wrappedValue) { sheet in
            ForEach(sheet.choices) { choice in
                Button(choice.label, role: choice.destructive ? .destructive : nil) { choice.onPick() }.disabled(choice.disabled)
            }
            Button(sheet.cancelLabel, role: .cancel) {}
        } message: { sheet in
            if let m = sheet.message { Text(m) }
        }
    }
}
