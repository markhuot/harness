import HarnessKit
import SwiftUI

/// A ticket's labels: chips (tap one to recolor it, × removes it), a field that completes over the
/// labels that exist and creates a new one on return, and the color presets for the chip being
/// recolored. A change goes out as the whole new list in one UpdateTicketBody (`onPatch`); a name
/// the service would refuse (empty, over 40 characters, holding a quote) is refused here with the reason.
struct TicketLabelsEditor: View {
    let ticket: Ticket
    var disabled = false
    let onPatch: (UpdateTicketBody) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var typed = ""
    @State private var error: String?
    @State private var recoloring: String?

    var body: some View {
        let labels = ticket.labels ?? []
        let known = store.state.labels
        let suggestions = typed.isEmpty ? [] : Array(LabelList.suggestions(typed, labels: known, excluding: labels).prefix(5))
        VStack(alignment: .leading, spacing: 10) {
            if !labels.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(labels, id: \.self) { name in
                        LabelChip(name: name, color: LabelList.colorId(name, in: known), onRemove: disabled ? nil : { remove(name) })
                            .overlay(recoloring == name ? Capsule().strokeBorder(c.accent, lineWidth: 1.5) : nil)
                            .onTapGesture { if !disabled { recoloring = recoloring == name ? nil : name } }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityIdentifier("ticket-label-\(name)")
                    }
                }
            }
            if let name = recoloring, let info = LabelList.info(name, in: known) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Color for \(info.name), on every ticket").font(.scaled(size: 12)).foregroundStyle(c.text3)
                    FlowLayout(spacing: 6) {
                        ForEach(ProjectColors.presets) { p in
                            Button { recolor(info.name, p.id) } label: {
                                Circle().fill(Color(css: p.hex) ?? c.accent)
                                    .frame(width: 24, height: 24)
                                    .overlay(info.color == p.id ? Circle().strokeBorder(c.text, lineWidth: 2).padding(-3) : nil)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(p.name)
                        }
                    }
                }
            }
            if !disabled {
                TextField("", text: $typed, prompt: Text("Add a label").foregroundStyle(c.text3))
                    .font(.scaled(size: 15))
                    .foregroundStyle(c.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { add(typed) }
                    .onChange(of: typed) { error = nil }
                    .accessibilityLabel("Add a label")
                if let error { Text(error).font(.scaled(size: 13)).foregroundStyle(c.red) }
                ForEach(suggestions) { s in
                    Button { add(s.name) } label: {
                        HStack(spacing: 8) {
                            LabelDot(color: s.color)
                            Text(s.name).font(.scaled(size: 15)).foregroundStyle(c.text)
                            Spacer(minLength: 0)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func add(_ raw: String) {
        let current = ticket.labels ?? []
        if let why = LabelName.rejection(raw) {
            error = why
            return
        }
        // Already on the ticket: nothing to send.
        if let next = LabelName.adding(raw, to: current) { onPatch(UpdateTicketBody(labels: next)) }
        typed = ""
        error = nil
    }

    private func remove(_ name: String) {
        onPatch(UpdateTicketBody(labels: LabelName.removing(name, from: ticket.labels ?? [])))
        if recoloring.map(LabelName.key) == LabelName.key(name) { recoloring = nil }
    }

    private func recolor(_ name: String, _ color: String) {
        actions.perform {
            let info = try await store.connectedAPI().updateLabel(name, color: color)
            var labels = store.state.labels
            if let i = labels.firstIndex(where: { $0.name == info.name }) { labels[i] = info }
            store.dispatch(.event(.labelsChanged(labels: labels)))
        }
    }
}
