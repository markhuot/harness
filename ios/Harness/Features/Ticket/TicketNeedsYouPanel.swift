import HarnessKit
import SwiftUI

/// "Needs you" (DESIGN.md "Open questions"): what the ticket waits on the human for, at the top of
/// the composer. On the Spec tab it's a panel: the blocked ticket's question (TicketBlockedCallout:
/// its Unblock, a restart time or a tool approval) first, then each unchecked task item under the
/// spec's Open questions heading as plain text with one growing reply field under it, then the
/// checked ones folded under "N answered". The replies are part of the message draft
/// (MessageDraftSync): they save as they're typed, go with the composer's Send as one message, and
/// stay in their fields afterwards, so the human can edit them and send again. The panel caps its
/// height and scrolls, so the composer stays on screen.
struct TicketNeedsYouPanel: View {
    let ticket: Ticket
    let panel: OpenQuestions.Panel
    let draft: MessageDraftSync
    /// A reply field gained or lost focus
    let onFocus: (Bool) -> Void

    @Environment(\.palette) private var c
    @State private var showAnswered = false

    var body: some View {
        let count = TicketNeedsYouPanel.count(ticket, panel)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Icon("alert", size: 12, weight: .semibold)
                Text(count > 0 ? "Needs you · \(count)" : "Nothing needs you").font(.scaled(size: 13, weight: .semibold))
                Spacer(minLength: 0)
            }
            .foregroundStyle(c.tone(.amber).fg)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TicketBlockedCallout(ticket: ticket)
                    ForEach(panel.open) { q in
                        VStack(alignment: .leading, spacing: 6) {
                            MarkdownView(text: q.question, size: 15)
                                .fontWeight(.medium)
                            ReplyField(question: q.question, draft: draft, onFocus: onFocus)
                        }
                        .accessibilityIdentifier("needs-you-question")
                    }
                    if !panel.answered.isEmpty {
                        DisclosureGroup(isExpanded: $showAnswered) {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(panel.answered) { q in
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Image(systemName: "checkmark.square.fill").foregroundStyle(c.text3)
                                        MarkdownView(text: q.question, size: 14)
                                    }
                                }
                            }
                            .padding(.top, 6)
                        } label: {
                            Text("\(panel.answered.count) answered").font(.scaled(size: 13)).foregroundStyle(c.text2)
                        }
                        .accessibilityIdentifier("needs-you-answered")
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 300)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        // Opaque, unlike the glass field under it: the spec scrolls behind the panel.
        .background(c.bgElev, in: .rect(cornerRadius: 18, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .accessibilityIdentifier("needs-you")
    }

    /// How many things wait on the human: the block (question, restart or approval) and the open questions.
    static func count(_ ticket: Ticket, _ panel: OpenQuestions.Panel) -> Int {
        (blocked(ticket) ? 1 : 0) + panel.open.count
    }

    /// Whether there's anything to show at all.
    static func shows(_ ticket: Ticket, _ panel: OpenQuestions.Panel) -> Bool {
        blocked(ticket) || !panel.open.isEmpty || !panel.answered.isEmpty
    }

    private static func blocked(_ ticket: Ticket) -> Bool {
        if case .none = BlockedCallout.of(ticket) { return false }
        return true
    }
}

/// A question's one reply field, growing with its text, edited in the message draft (empty drops it).
private struct ReplyField: View {
    let question: String
    let draft: MessageDraftSync
    let onFocus: (Bool) -> Void

    @Environment(\.palette) private var c
    @FocusState private var focused: Bool

    var body: some View {
        TextField("", text: Binding(get: { draft.questionReplies.first { $0.question == question }?.body ?? "" },
                                    set: { draft.setReply($0, to: question) }),
                  prompt: Text("Your answer").foregroundStyle(c.text3), axis: .vertical)
            .font(.scaled(size: 15))
            .foregroundStyle(c.text)
            .lineLimit(1...8)
            .focused($focused)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(c.bg, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? c.accent : c.border))
            .onChange(of: focused) { _, now in onFocus(now) }
            .accessibilityLabel("Reply to \(question)")
            .accessibilityIdentifier("needs-you-reply")
    }
}

/// Off the Spec tab (or on iPhone while the keyboard is up for the message): how many things wait
/// on the human, opening the panel.
struct NeedsYouChip: View {
    let count: Int
    let onOpen: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        Button {
            haptic(.tap)
            onOpen()
        } label: {
            HStack(spacing: 5) {
                Icon("alert", size: 12, weight: .semibold)
                Text(count == 1 ? "1 question needs you" : "\(count) questions need you").font(.scaled(size: 13, weight: .semibold))
            }
            .foregroundStyle(c.tone(.amber).fg)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .glassEffect(.regular, in: .capsule)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("needs-you-chip")
    }
}
