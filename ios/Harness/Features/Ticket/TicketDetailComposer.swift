import HarnessKit
import SwiftUI

/// The message composer under every tab: @file mentions and /commands,
/// a placeholder for the ticket's state (red while it's blocked on the human), the switch that moves
/// the ticket first and the hint about what a message does. The switch and hint show only while
/// writing: once the field is focused, and after a blur only while it holds a message.
struct TicketDetailComposer: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var text = ""
    @State private var sending = false
    /// Off by default and after every send: the ticket stays where it is unless asked to move first.
    @State private var moveFirst = false
    @State private var focused = false

    var body: some View {
        let switchLabel = Format.moveSwitchLabel(ticket)
        let move = switchLabel != nil && moveFirst
        let hint = Format.composerHint(ticket, move: move)
        let writing = focused || !TicketDetailLogic.trim(text).isEmpty
        let attention = ticket.status == .blocked
        let empty = TicketDetailLogic.trim(text).isEmpty
        VStack(spacing: 4) {
            if writing && (switchLabel != nil || !hint.isEmpty) {
                HStack(spacing: 8) {
                    if let switchLabel {
                        Toggle(switchLabel, isOn: Binding(get: { moveFirst }, set: { on in
                            haptic(.select)
                            moveFirst = on
                        }))
                        .labelsHidden()
                        .tint(c.accent)
                        .scaleEffect(0.75)
                        .frame(width: 40)
                        Text(switchLabel).font(.scaled(size: 13)).foregroundStyle(c.text2).accessibilityHidden(true)
                    }
                    if !hint.isEmpty {
                        Text(hint)
                            .font(.scaled(size: 12))
                            .foregroundStyle(c.text3)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: switchLabel != nil ? .trailing : .leading)
                    }
                }
                .padding(.horizontal, 6)
            }
            HStack(alignment: .bottom, spacing: 8) {
                MentionTextEditor(text: $text,
                                  placeholder: Format.composerPlaceholder[ticket.status] ?? "",
                                  ticketKey: ticket.key,
                                  minHeight: 0,
                                  maxLines: 6,
                                  suggestionsEdge: .top,
                                  suggestionsMaxHeight: 200,
                                  fieldLabel: "Message the agent",
                                  placeholderColor: attention ? c.red : nil,
                                  onFocusChange: { focused = $0 },
                                  fieldBox: MentionFieldBox(fill: c.bg, border: attention ? c.red : c.border, cornerRadius: 20,
                                                            padding: EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14)))
                Button { send(move: move) } label: {
                    ZStack {
                        Circle().fill(c.accent)
                        if sending {
                            ProgressView().tint(c.onAccent)
                        } else {
                            Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)).foregroundStyle(c.onAccent)
                        }
                    }
                    .frame(width: 40, height: 40)
                    .opacity(empty || sending ? 0.4 : 1)
                }
                .buttonStyle(.plain)
                .disabled(empty || sending)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(c.bgElev)
        .overlay(alignment: .top) { Rectangle().fill(c.border).frame(height: 1 / 3) }
    }

    private func send(move: Bool) {
        let body = TicketDetailLogic.trim(text)
        guard !body.isEmpty, !sending else { return }
        let key = ticket.key
        sending = true
        Task {
            // No client: connectedAPI throws, so it toasts rather than dropping the message without a word.
            let ok = await actions.run { try await store.connectedAPI().sendMessage(key, text: body, move: move) }
            sending = false
            if ok != nil {
                haptic(.success)
                text = ""
                moveFirst = false
            }
        }
    }
}
