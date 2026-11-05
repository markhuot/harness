import Foundation

// Port of shared/src/state/openQuestions.ts. A spec's open questions (DESIGN.md "Open questions"):
// the GFM task items under its "Open questions" heading. Agents write them (`- [ ] question`) and
// resolve them by moving the answer into the spec and removing the item or checking it off. The
// ticket screen lists them in the Needs you panel above the composer, where the human replies to
// several at once.

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

    /// A reply the human already sent under a question (an `answered` Activity entry's meta.questionReplies).
    public struct SentReply: Equatable, Sendable {
        public var body: String
        public var at: Timestamp
    }

    /// One question as the panel shows it: its sent replies, oldest first, and the reply being drafted.
    public struct Thread: Equatable, Sendable, Identifiable {
        public var question: String
        public var checked: Bool
        public var sent: [SentReply]
        public var draft: String
        public var id: String { question }
    }

    public struct Panel: Equatable, Sendable {
        /// The unchecked questions, in the spec's order
        public var open: [Thread]
        /// The checked ones, folded into an "N answered" disclosure
        public var answered: [Thread]
        /// Drafted replies whose question isn't in the spec anymore: kept until sent or discarded.
        public var detached: [QuestionReply]

        public static let empty = Panel(open: [], answered: [], detached: [])
    }

    /// `openQuestions`: the task items under the spec's Open questions heading (any level, any
    /// case), down to the next heading of the same or a higher level, in order, nested ones
    /// included. Plain bullets and prose there aren't questions.
    public static func questions(_ spec: String) -> [Question] {
        let blocks = Markdown.parseBlocks(spec)
        guard let start = blocks.firstIndex(where: { if case let .h(_, text) = $0 { isHeading(text) } else { false } }),
              case let .h(level, _) = blocks[start] else { return [] }
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
        for b in blocks[(start + 1)...] {
            if case let .h(l, _) = b, l <= level { break }
            walk([b])
        }
        return out
    }

    /// `/^open questions?\s*:?$/i`
    private static func isHeading(_ text: String) -> Bool {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if t.hasSuffix(":") { t = String(t.dropLast()).trimmingCharacters(in: .whitespaces) }
        return t == "open questions" || t == "open question"
    }

    /// `pendingQuestionReplies`: the replies worth sending, trimmed, blank ones dropped.
    public static func pending(_ replies: [QuestionReply]) -> [QuestionReply] {
        replies.map {
            QuestionReply(question: $0.question.trimmingCharacters(in: .whitespacesAndNewlines), body: $0.body.trimmingCharacters(in: .whitespacesAndNewlines))
        }.filter { !$0.question.isEmpty && !$0.body.isEmpty }
    }

    /// `questionPanel`: the spec's questions, each with what the human already sent under it
    /// (matched by the question's text) and the reply in the draft.
    public static func panel(spec: String, activity: [ActivityEntry], drafts: [QuestionReply]) -> Panel {
        var sent: [String: [SentReply]] = [:]
        for e in activity.sorted(by: { $0.createdAt < $1.createdAt }) where e.kind == .answered {
            for r in e.meta.questionReplies ?? [] {
                sent[r.question, default: []].append(SentReply(body: r.body, at: e.createdAt))
            }
        }
        let qs = questions(spec)
        func thread(_ q: Question) -> Thread {
            Thread(question: q.text, checked: q.checked, sent: sent[q.text] ?? [], draft: drafts.first { $0.question == q.text }?.body ?? "")
        }
        let known = Set(qs.map(\.text))
        return Panel(
            open: qs.filter { !$0.checked }.map(thread),
            answered: qs.filter(\.checked).map(thread),
            detached: drafts.filter { !known.contains($0.question) && !$0.body.allSatisfy(\.isWhitespace) }
        )
    }
}
