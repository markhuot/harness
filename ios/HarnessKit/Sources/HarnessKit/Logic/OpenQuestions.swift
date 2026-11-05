import Foundation

// Port of shared/src/state/openQuestions.ts. A spec's open questions (DESIGN.md "Open questions"):
// every GFM task item in it (`- [ ] question`), under any heading or none. Agents write them wherever
// they fit and resolve them by moving the answer into the spec and removing the item or checking it
// off. The ticket screen shows each with an answer field, in the Needs you panel above the composer
// or inline in the spec (NeedsYouLayout); the replies stay after a send, to edit and send again.

public enum OpenQuestions {
    public struct Question: Equatable, Sendable {
        /// The item's text, as written: also the question's identity (replies and drafts match on it).
        public var text: String
        public var checked: Bool

        public init(text: String, checked: Bool) {
            self.text = text
            self.checked = checked
        }
    }

    /// One question as the panel shows it, with the reply in the draft.
    public struct Thread: Equatable, Sendable, Identifiable {
        public var question: String
        public var checked: Bool
        public var draft: String
        public var id: String { question }
    }

    public struct Panel: Equatable, Sendable {
        /// The unchecked questions, in the spec's order
        public var open: [Thread]
        /// The checked ones, folded into an "N answered" disclosure
        public var answered: [Thread]

        public static let empty = Panel(open: [], answered: [])
    }

    /// `openQuestions`: every task item in the spec, in document order, nested ones included,
    /// checked or not. Plain bullets and prose aren't questions, and neither is anything inside a
    /// code block.
    public static func questions(_ spec: String) -> [Question] {
        var out: [Question] = []
        func walk(_ list: [Markdown.Block]) {
            for b in list {
                let items: [Markdown.ListItem]
                switch b {
                case let .ul(xs): items = xs
                case let .ol(_, xs): items = xs
                default: continue
                }
                for it in items {
                    let text = it.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let checked = it.checked, !text.isEmpty { out.append(Question(text: text, checked: checked)) }
                    walk(it.children)
                }
            }
        }
        walk(Markdown.parseBlocks(spec))
        return out
    }

    /// `pendingQuestionReplies`: the replies worth sending, trimmed, blank ones dropped.
    public static func pending(_ replies: [QuestionReply]) -> [QuestionReply] {
        replies.map {
            QuestionReply(question: $0.question.trimmingCharacters(in: .whitespacesAndNewlines), body: $0.body.trimmingCharacters(in: .whitespacesAndNewlines))
        }.filter { !$0.question.isEmpty && !$0.body.isEmpty }
    }

    /// `questionPanel`: the spec's questions, each with its reply in the draft (matched by the
    /// question's text).
    public static func panel(spec: String, drafts: [QuestionReply]) -> Panel {
        let qs = questions(spec)
        func thread(_ q: Question) -> Thread {
            Thread(question: q.text, checked: q.checked, draft: drafts.first { $0.question == q.text }?.body ?? "")
        }
        return Panel(open: qs.filter { !$0.checked }.map(thread), answered: qs.filter(\.checked).map(thread))
    }

    /// `sendableQuestionReplies`: the replies a Send delivers, the non-blank ones under questions
    /// still open. Replies stay in the draft after a send, so one under a question the agent has
    /// since resolved or reworded is kept but no longer goes out.
    public static func sendable(spec: String, replies: [QuestionReply]) -> [QuestionReply] {
        let open = Set(questions(spec).filter { !$0.checked }.map(\.text))
        return pending(replies).filter { open.contains($0.question) }
    }
}
