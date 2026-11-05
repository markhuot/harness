import Testing
import HarnessKit

/// The Swift ports of task-list parsing and shared/src/state/openQuestions.ts read specs the way the TS does.
@Suite struct OpenQuestionsTests {
    @Test func taskItemsCarryCheckedAndLoseTheirMarker() throws {
        guard case let .ul(items)? = Markdown.parseBlocks("- [ ] a\n- [x] b\n- [X] c\n- plain\n- [x]b").first else { Issue.record("no list"); return }
        #expect(items.map(\.text) == ["a", "b", "c", "plain", "[x]b"])
        #expect(items.map(\.checked) == [false, true, true, nil, nil])
    }

    @Test func questionsAreTheTaskItemsUnderTheHeading() {
        let spec = "## Goal\n- [ ] not one\n\n## Open questions\n\n- [ ] Which DB?\n- [x] Which port?\n- plain bullet\n### Sub\n- [ ] Nested section\n## Status\n- [ ] not one either"
        #expect(OpenQuestions.questions(spec) == [
            .init(text: "Which DB?", checked: false),
            .init(text: "Which port?", checked: true),
            .init(text: "Nested section", checked: false),
        ])
        #expect(OpenQuestions.questions("### OPEN QUESTIONS:\n- [ ] a").map(\.text) == ["a"])
        #expect(OpenQuestions.questions("## Questions\n- [ ] a").isEmpty)
    }

    @Test func thePanelThreadsSentRepliesAndDrafts() {
        let spec = "## Open questions\n- [ ] Which DB?\n- [x] Which port?"
        let entry = { (at: Double, replies: [QuestionReply]) in
            ActivityEntry(id: "\(at)", sessionId: "s", kind: .answered, author: .human, body: "", meta: ActivityMeta(questionReplies: replies), createdAt: at)
        }
        let panel = OpenQuestions.panel(
            spec: spec,
            activity: [entry(2, [.init(question: "Which DB?", body: "PG 17")]), entry(1, [.init(question: "Which DB?", body: "PG")])],
            drafts: [.init(question: "Which DB?", body: "and Redis"), .init(question: "Reworded?", body: "yes")]
        )
        #expect(panel.open.map(\.question) == ["Which DB?"])
        #expect(panel.open[0].sent.map(\.body) == ["PG", "PG 17"])
        #expect(panel.open[0].draft == "and Redis")
        #expect(panel.answered.map(\.question) == ["Which port?"])
        #expect(panel.detached == [.init(question: "Reworded?", body: "yes")])
    }

    @Test func aReplyIsKeptOncePerQuestionAndDroppedWhenEmptied() {
        var r = MessageDrafts.withReply([], question: "a", body: "1")
        r = MessageDrafts.withReply(r, question: "b", body: "2")
        r = MessageDrafts.withReply(r, question: "a", body: "1!")
        #expect(r == [.init(question: "a", body: "1!"), .init(question: "b", body: "2")])
        #expect(MessageDrafts.withReply(r, question: "a", body: "") == [.init(question: "b", body: "2")])
    }
}
