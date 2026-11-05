import HarnessKit
import SwiftUI

/// "Needs you" (DESIGN.md "Open questions"): what the ticket waits on the human for, at the top of
/// the composer. On the Spec tab it's a panel: the blocked ticket's question (TicketBlockedCallout:
/// its Unblock, a restart time or a tool approval) first, then each unchecked task item under the
/// spec's Open questions heading, with the replies already sent under it and a field for the next
/// one, then the checked ones folded under "N answered". The replies are part of the message draft
/// (MessageDraftSync), so they save as they're typed and go with the composer's Send as one
/// message. The panel caps its height and scrolls, so the composer stays on screen.
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
                VStack(alignment: .leading, spacing: 8) {
                    TicketBlockedCallout(ticket: ticket)
                    ForEach(panel.open) { q in
                        question(q)
                    }
                    ForEach(panel.detached, id: \.question) { r in
                        detached(r)
                    }
                    if !panel.answered.isEmpty {
                        DisclosureGroup(isExpanded: $showAnswered) {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(panel.answered) { q in answered(q) }
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
        .glassEffect(.regular, in: .rect(cornerRadius: 18, style: .continuous))
        .accessibilityIdentifier("needs-you")
    }

    /// How many things wait on the human: the block (question, restart or approval) and the open questions.
    static func count(_ ticket: Ticket, _ panel: OpenQuestions.Panel) -> Int {
        (blocked(ticket) ? 1 : 0) + panel.open.count
    }

    private static func blocked(_ ticket: Ticket) -> Bool {
        if case .none = BlockedCallout.of(ticket) { return false }
        return true
    }

    /// Whether there's anything to show at all.
    static func shows(_ ticket: Ticket, _ panel: OpenQuestions.Panel) -> Bool {
        blocked(ticket) || !panel.open.isEmpty || !panel.answered.isEmpty || !panel.detached.isEmpty
    }

    private func question(_ q: OpenQuestions.Thread) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownView(text: q.question, size: 15)
                .fontWeight(.medium)
            sent(q)
            ReplyField(question: q.question, placeholder: q.sent.isEmpty ? "Reply to this question" : "Add to your reply",
                       draft: draft, onFocus: onFocus)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.bg, in: .rect(cornerRadius: 10))
        .overlay(alignment: .leading) { Rectangle().fill(c.tone(.amber).fg).frame(width: 3).clipShape(.rect(cornerRadius: 1.5)) }
        .accessibilityIdentifier("needs-you-question")
    }

    private func detached(_ r: QuestionReply) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Question changed: “\(r.question)”").font(.scaled(size: 13)).foregroundStyle(c.text3)
            ReplyField(question: r.question, placeholder: "Your reply", draft: draft, onFocus: onFocus)
            Button("Discard") { draft.setReply("", to: r.question) }
                .font(.scaled(size: 13, weight: .semibold))
        }
        .padding(10)
        .background(c.bg, in: .rect(cornerRadius: 10))
        .accessibilityIdentifier("needs-you-detached")
    }

    private func answered(_ q: OpenQuestions.Thread) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "checkmark.square.fill").foregroundStyle(c.green)
                MarkdownView(text: q.question, size: 14)
            }
            sent(q)
        }
    }

    @ViewBuilder private func sent(_ q: OpenQuestions.Thread) -> some View {
        if !q.sent.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(q.sent.indices, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 1) {
                        Text("You · \(Date(timeIntervalSince1970: q.sent[i].at / 1000).formatted(.relative(presentation: .named)))")
                            .font(.scaled(size: 11)).foregroundStyle(c.text3)
                        MarkdownView(text: q.sent[i].body, size: 14)
                    }
                }
            }
            .padding(.leading, 8)
            .overlay(alignment: .leading) { Rectangle().fill(c.border).frame(width: 2) }
            .accessibilityIdentifier("needs-you-sent")
        }
    }
}

/// A reply under one question, edited in the message draft (empty drops it).
private struct ReplyField: View {
    let question: String
    let placeholder: String
    let draft: MessageDraftSync
    let onFocus: (Bool) -> Void

    @Environment(\.palette) private var c
    @FocusState private var focused: Bool

    var body: some View {
        TextField("", text: Binding(get: { draft.questionReplies.first { $0.question == question }?.body ?? "" },
                                    set: { draft.setReply($0, to: question) }),
                  prompt: Text(placeholder).foregroundStyle(c.text3), axis: .vertical)
            .font(.scaled(size: 15))
            .foregroundStyle(c.text)
            .lineLimit(1...5)
            .focused($focused)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(c.bgElev, in: .rect(cornerRadius: 8))
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
