import HarnessKit
import SwiftUI

/// "Needs you" (DESIGN.md "Open questions"): what the ticket waits on the human for, at the top of
/// the composer on the Spec tab of a large landscape view (OpenQuestions.layout `.panel`): each
/// open question item (`- ( )`) anywhere in the spec as plain text with one growing
/// answer field 6pt under it and 20pt between questions, then the answered ones folded under "N
/// answered". The answers are part of the message draft (MessageDraftSync): they save as they're
/// typed, go with the composer's Send as one message, and stay in their fields afterwards, so the
/// human can edit them and send again. The panel caps its height and scrolls, so the composer stays
/// on screen. A blocked ticket's question isn't here: it heads the Spec tab (TicketBlockedCallout),
/// though the count still includes it.
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
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(panel.open) { q in
                        VStack(alignment: .leading, spacing: 6) {
                            MarkdownView(text: q.question, size: 15)
                                .fontWeight(.medium)
                            QuestionAnswerField(question: q.question, draft: draft, onFocus: onFocus)
                        }
                        .accessibilityIdentifier("needs-you-question")
                    }
                    if !panel.answered.isEmpty {
                        DisclosureGroup(isExpanded: $showAnswered) {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(panel.answered) { q in
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Image(systemName: "checkmark.circle").foregroundStyle(c.tone(.amber).fg)
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

    /// Whether there are questions to show at all (the block heads the spec instead).
    static func shows(_ panel: OpenQuestions.Panel) -> Bool {
        !panel.open.isEmpty || !panel.answered.isEmpty
    }

    private static func blocked(_ ticket: Ticket) -> Bool {
        if case .none = BlockedCallout.of(ticket) { return false }
        return true
    }
}
