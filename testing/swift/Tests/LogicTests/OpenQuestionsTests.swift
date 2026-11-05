import Testing
import HarnessKit

/// The Swift ports of task-list parsing and shared/src/state/openQuestions.ts read specs the way the TS does.
@Suite struct OpenQuestionsTests {
    @Test func taskItemsCarryCheckedAndLoseTheirMarker() throws {
        guard case let .ul(items)? = Markdown.parseBlocks("- [ ] a\n- [x] b\n- [X] c\n- plain\n- [x]b").first else { Issue.record("no list"); return }
        #expect(items.map(\.text) == ["a", "b", "c", "plain", "[x]b"])
        #expect(items.map(\.checked) == [false, true, true, nil, nil])
    }

    @Test func everyTaskItemIsAQuestionInDocumentOrderOutsideCodeBlocks() {
        let spec = "## Goal\n- [ ] Goal one\n- plain bullet\n\n## Plan\n1. Step\n   - [x] Nested\n\n```\n- [ ] in code\n```\n\n## Open questions\n- [ ] Last"
        #expect(OpenQuestions.questions(spec) == [
            .init(text: "Goal one", checked: false),
            .init(text: "Nested", checked: true),
            .init(text: "Last", checked: false),
        ])
        #expect(OpenQuestions.questions("No lists here.\n\n- plain").isEmpty)
    }

    @Test func thePanelPairsEachQuestionWithItsDraftAndSendsOnlyOpenOnes() {
        let spec = "## Open questions\n- [ ] Which DB?\n- [x] Which port?"
        let drafts: [QuestionReply] = [.init(question: "Which DB?", body: " PG "), .init(question: "Which port?", body: "5432"), .init(question: "Reworded?", body: "yes")]
        let panel = OpenQuestions.panel(spec: spec, drafts: drafts)
        #expect(panel.open.map(\.question) == ["Which DB?"])
        #expect(panel.open[0].draft == " PG ")
        #expect(panel.answered.map(\.question) == ["Which port?"])
        #expect(OpenQuestions.sendable(spec: spec, replies: drafts) == [.init(question: "Which DB?", body: "PG")])
    }

    @Test func aReplyIsKeptOncePerQuestionAndDroppedWhenEmptied() {
        var r = MessageDrafts.withReply([], question: "a", body: "1")
        r = MessageDrafts.withReply(r, question: "b", body: "2")
        r = MessageDrafts.withReply(r, question: "a", body: "1!")
        #expect(r == [.init(question: "a", body: "1!"), .init(question: "b", body: "2")])
        #expect(MessageDrafts.withReply(r, question: "a", body: "") == [.init(question: "b", body: "2")])
    }

    @Test func theLayoutFollowsTheViewSizeLikeTheTS() {
        #expect(OpenQuestions.layout(width: 700, height: 600) == .panel)
        #expect(OpenQuestions.layout(width: 699, height: 600) == .inline)
        #expect(OpenQuestions.layout(width: 700, height: 599) == .inline)
        #expect(OpenQuestions.layout(width: 1032, height: 1376) == .inline)
        #expect(OpenQuestions.layout(width: 1376, height: 1032) == .panel)
        #expect(OpenQuestions.layout(width: 430, height: 932) == .inline)
    }

    @Test func theBarSendsOnceAnswersAreReady() {
        #expect(OpenQuestions.bar(count: 2, ready: 0, questions: 2) == .init(label: "Needs you · 2", action: .focus))
        #expect(OpenQuestions.bar(count: 3, ready: 1, questions: 2) == .init(label: "1/2 answers ready · Send", action: .send))
        #expect(OpenQuestions.bar(count: 1, ready: 1, questions: 1) == .init(label: "1/1 answer ready · Send", action: .send))
        #expect(OpenQuestions.bar(count: 0, ready: 2, questions: 1) == .init(label: "2/2 answers ready · Send", action: .send))
        #expect(OpenQuestions.bar(count: 0, ready: 0, questions: 0) == nil)
    }

    @Test func theBarFocusesTheFirstOpenQuestionOrElseTheComposer() {
        #expect(OpenQuestions.focusTarget(spec: "- [x] Done?\n\n## Plan\n- [ ] Which DB?\n- [ ] Which port?") == .question("Which DB?"))
        #expect(OpenQuestions.focusTarget(spec: "## Plan\n- [x] Done?\n- plain item") == .composer)
        #expect(OpenQuestions.focusTarget(spec: "") == .composer)
    }

    @Test func onlyASendFromTheSpecTabCarriesTheReplies() {
        let spec = "## Plan\n- [ ] Which DB?"
        let replies: [QuestionReply] = [.init(question: "Which DB?", body: "PG")]
        #expect(OpenQuestions.outgoing(spec: spec, replies: replies, tab: .spec) == replies)
        #expect(OpenQuestions.outgoing(spec: spec, replies: replies, tab: .transcript) == [])
    }
}
