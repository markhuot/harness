import HarnessKit
import SwiftUI

/// The ticket screen's open questions (DESIGN.md "Open questions"), shared by the Spec tab and the
/// composer: the layout the ticket view's size picks (OpenQuestions.layout, measured by
/// TicketDetailBody, again on every rotation or resize) and the inline bar's request to focus a
/// question's answer field in the spec. The answers themselves live in the message draft, so they
/// carry across a switch between the layouts.
@MainActor
@Observable
final class SpecQuestions {
    /// `.panel`: the Needs you panel above the composer. `.inline`: an answer field under each
    /// question in the spec and a one-line bar above the composer.
    var layout: OpenQuestions.Layout = .inline

    struct FocusRequest: Equatable {
        let question: String
        let nonce: Int
    }

    /// The latest request from the bar: the spec scrolls to this question and its field takes focus.
    private(set) var focusRequest: FocusRequest?

    func focus(_ question: String) {
        focusRequest = FocusRequest(question: question, nonce: (focusRequest?.nonce ?? 0) + 1)
    }

    /// The scroll target of a question's inline answer field.
    static func anchor(_ question: String) -> String { "spec-question:\(question)" }
}

/// What MarkdownView puts under each open question item (`- ( )`): the answer field for the item's text
/// (its question). Only the Spec tab's current spec sets one, in the inline layout.
struct TaskAnswerField: Sendable {
    let make: @MainActor @Sendable (String) -> AnyView
}

extension EnvironmentValues {
    /// The ticket screen's open questions; nil outside it (a pinned tab window), where the spec
    /// shows only the questions' circles.
    @Entry var specQuestions: SpecQuestions?
    /// An answer field under each open question item of a rendered markdown (MarkdownListView);
    /// nil renders only their circles.
    @Entry var taskAnswerField: TaskAnswerField?
}

/// A question's one answer field, growing with its text, edited in the message draft (empty drops
/// the reply). In the spec it also answers the bar's focus requests for its question.
struct QuestionAnswerField: View {
    let question: String
    let draft: MessageDraftSync
    let onFocus: (Bool) -> Void
    var requests: SpecQuestions?
    var identifier = "needs-you-reply"

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
            .onChange(of: requests?.focusRequest) { _, request in
                if request?.question == question { focused = true }
            }
            .accessibilityLabel("Answer to \(question)")
            .accessibilityIdentifier(identifier)
    }
}

/// The inline layout's one-line bar above the composer (OpenQuestions.bar): "Needs you · N" takes
/// the human to the first open question (or the composer), "N answers ready · Send" sends.
struct NeedsYouBar: View {
    let bar: OpenQuestions.Bar
    let onTap: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        Button {
            haptic(.tap)
            onTap()
        } label: {
            HStack(spacing: 6) {
                if bar.action == .send {
                    Image(systemName: "arrow.up.circle.fill").font(.scaled(size: 13, weight: .semibold))
                } else {
                    Icon("alert", size: 12, weight: .semibold)
                }
                Text(bar.label).font(.scaled(size: 13, weight: .semibold))
                Spacer(minLength: 0)
                if bar.action == .focus { Image(systemName: "chevron.up").font(.scaled(size: 11, weight: .semibold)) }
            }
            .foregroundStyle(bar.action == .send ? c.accent : c.tone(.amber).fg)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .contentShape(.capsule)
            // Opaque, like the panel: the spec scrolls behind it.
            .background(c.bgElev, in: .capsule)
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("needs-you-bar")
    }
}
