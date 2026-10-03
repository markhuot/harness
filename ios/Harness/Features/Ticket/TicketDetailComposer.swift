import HarnessKit
import SwiftUI

/// The message composer under every tab: @file mentions and /commands,
/// a placeholder for the ticket's state and where the message shows (red while it's blocked on the
/// human), the switch that moves
/// the ticket first and the hint about what a message does. The switch and hint show only while
/// writing: once the field is focused, and after a blur only while it holds a message. A message
/// sent from the Spec or Activity tab also goes into Activity (`log`); from any other tab it goes
/// to the agent and the Transcript only. The field and send button are Liquid Glass floating over
/// the tab, with no bar of their own.
struct TicketDetailComposer: View {
    let ticket: Ticket
    /// The tab on screen, which decides whether the message is logged
    let tab: TicketTab

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
                                  placeholder: TicketDetailLogic.composerPlaceholder(ticket, tab: tab),
                                  ticketKey: ticket.key,
                                  minHeight: 0,
                                  maxLines: 6,
                                  suggestionsEdge: .top,
                                  suggestionsMaxHeight: 200,
                                  fieldLabel: "Message the agent",
                                  placeholderColor: attention ? c.red : nil,
                                  onFocusChange: { focused = $0 },
                                  fieldBox: MentionFieldBox(border: attention ? c.red : nil, cornerRadius: 22,
                                                            padding: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16),
                                                            glass: true))
                sendButton(disabled: empty || sending) { send(move: move) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    /// Prominent accent glass while there's something to send. Disabled, a prominent glass button
    /// still reads as enabled in dark mode, so it drops to plain glass and a dimmed arrow.
    @ViewBuilder private func sendButton(disabled: Bool, action: @escaping () -> Void) -> some View {
        let label = Group {
            if sending {
                ProgressView()
            } else {
                Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
            }
        }
        .frame(width: 30, height: 30)
        if disabled {
            Button(action: action) { label.foregroundStyle(c.text3) }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .disabled(true)
                .accessibilityLabel("Send")
        } else {
            Button(action: action) { label }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(c.accent)
                .accessibilityLabel("Send")
        }
    }

    private func send(move: Bool) {
        let body = TicketDetailLogic.trim(text)
        guard !body.isEmpty, !sending else { return }
        let key = ticket.key
        let log = TicketDetailLogic.composerLogs(tab)
        sending = true
        Task {
            // No client: connectedAPI throws, so it toasts rather than dropping the message without a word.
            let ok = await actions.run { try await store.connectedAPI().sendMessage(key, text: body, move: move, log: log) }
            sending = false
            if ok != nil {
                haptic(.success)
                text = ""
                moveFirst = false
            }
        }
    }
}
