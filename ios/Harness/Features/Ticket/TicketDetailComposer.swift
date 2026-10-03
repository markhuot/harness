import HarnessKit
import SwiftUI

/// The message composer under every tab: @file mentions and /commands,
/// a placeholder for the ticket's state (red while it's blocked on the human), the switch that moves
/// the ticket first and the hint about what a message does. The switch and hint show only while
/// writing: once the field is focused, and after a blur only while it holds a message. A message
/// goes to the agent and shows in the Transcript, never in Activity, so a send that goes through
/// opens the Transcript from any tab (Tabs.tabAfterSend). The field and send button
/// are Liquid Glass floating over the tab, with no bar of their own.
struct TicketDetailComposer: View {
    let ticket: Ticket
    /// The tab on screen
    let tab: TicketTab
    /// Shows a tab of the ticket: the Transcript once a message went through
    let onTab: (TicketTab) -> Void

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
                                  placeholder: TicketDetailLogic.composerPlaceholder(ticket),
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
                sendButton(active: focused || !empty, disabled: empty || sending) { send(move: move) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    /// Prominent accent glass while writing (focused, or holding a message), plain glass with a dimmed
    /// arrow otherwise. Focused but empty it stays prominent and ignores taps rather than `.disabled`,
    /// which would grey the glass out.
    @ViewBuilder private func sendButton(active: Bool, disabled: Bool, action: @escaping () -> Void) -> some View {
        let label = Group {
            if sending {
                ProgressView()
            } else {
                Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
            }
        }
        .frame(width: 30, height: 30)
        if active {
            Button { if !disabled { action() } } label: { label }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(c.accent)
                .accessibilityLabel("Send")
                .accessibilityHint(disabled ? "Write a message first" : "")
        } else {
            Button(action: action) { label.foregroundStyle(c.text3) }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .disabled(true)
                .accessibilityLabel("Send")
        }
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
            let next = Tabs.tabAfterSend(tab, sent: ok != nil)
            if next != tab { onTab(next) }
        }
    }
}
