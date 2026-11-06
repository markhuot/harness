import Testing
import HarnessKit

/// The Swift ports of task and question item parsing and shared/src/state/openQuestions.ts read specs the way the TS does.
@Suite struct OpenQuestionsTests {
    @Test func taskAndQuestionItemsCarryCheckedAndLoseTheirMarker() throws {
        guard case let .ul(items)? = Markdown.parseBlocks("- [ ] a\n- [x] b\n- [X] c\n- plain\n- [x]b\n- ( ) d\n- (x) e\n- (X) f\n- (x)g\n- (see) h").first else { Issue.record("no list"); return }
        #expect(items.map(\.text) == ["a", "b", "c", "plain", "[x]b", "d", "e", "f", "(x)g", "(see) h"])
        #expect(items.map(\.checked) == [false, true, true, nil, nil, false, true, true, nil, nil])
        #expect(items.map(\.isQuestion) == [false, false, false, false, false, true, true, true, false, false])
    }

    @Test func everyQuestionItemIsAQuestionInDocumentOrderOutsideCodeBlocksAndTaskItemsAreNot() {
        let spec = "## Goal\n- ( ) Goal one\n- plain bullet\n- [ ] A checklist step\n\n## Plan\n1. Step\n   - (x) Nested\n   - [x] Done step\n\n```\n- ( ) in code\n```\n\n## Open questions\n- ( ) Last"
        #expect(OpenQuestions.questions(spec) == [
            .init(text: "Goal one", checked: false),
            .init(text: "Nested", checked: true),
            .init(text: "Last", checked: false),
        ])
        #expect(OpenQuestions.questions("No lists here.\n\n- plain\n- [ ] a task").isEmpty)
    }

    @Test func thePanelPairsEachQuestionWithItsDraftAndSendsOnlyOpenOnes() {
        let spec = "## Open questions\n- ( ) Which DB?\n- (x) Which port?"
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
        #expect(OpenQuestions.focusTarget(spec: "- (x) Done?\n\n## Plan\n- [ ] A task\n- ( ) Which DB?\n- ( ) Which port?") == .question("Which DB?"))
        #expect(OpenQuestions.focusTarget(spec: "## Plan\n- (x) Done?\n- [ ] A task\n- plain item") == .composer)
        #expect(OpenQuestions.focusTarget(spec: "") == .composer)
    }

    @Test func onlyASendFromTheSpecTabCarriesTheReplies() {
        let spec = "## Plan\n- ( ) Which DB?"
        let replies: [QuestionReply] = [.init(question: "Which DB?", body: "PG")]
        #expect(OpenQuestions.outgoing(spec: spec, replies: replies, tab: .spec) == replies)
        #expect(OpenQuestions.outgoing(spec: spec, replies: replies, tab: .transcript) == [])
    }
}
