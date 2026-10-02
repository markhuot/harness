import Testing
@testable import HarnessKit

struct SkipReviewHintInput: Decodable, Sendable {
    let status: TicketStatus
    let agentReview: ReviewState
    let skipAgentReview: Bool?
}

@Suite("NewSession")
struct NewSessionTests {
    @Test(arguments: Fixture.cases("mobileNewSession", "skipReviewHintCases", input: SkipReviewHintInput.self, output: String.self))
    func skipReviewHint(_ c: Fixture.Case<SkipReviewHintInput, String>) {
        #expect(NewSession.skipReviewHint(status: c.input.status, agentReview: c.input.agentReview, skipAgentReview: c.input.skipAgentReview) == c.output)
    }

    @Test func ticketOverloadReadsTheTicketsFields() throws {
        var t = try Fixture.value("protocol", "Ticket", as: [Ticket].self)[0]
        t.status = .review
        t.agentReview = .skipped
        t.skipAgentReview = true
        #expect(NewSession.skipReviewHint(t) == "Off starts the review")
        t.skipAgentReview = nil
        t.agentReview = .pending
        #expect(NewSession.skipReviewHint(t) == "On skips the pending review")
    }

    struct HumanCase: CustomTestStringConvertible, Sendable {
        let status: TicketStatus
        let agentReview: ReviewState
        let humanReview: ReviewState
        let skipAgentReview: Bool?
        let skipHumanReview: Bool?
        let output: String
        var testDescription: String { "\(status.rawValue) agent=\(agentReview.rawValue) human=\(humanReview.rawValue) skipA=\(String(describing: skipAgentReview)) skipH=\(String(describing: skipHumanReview))" }
    }

    static let humanCases: [HumanCase] = [
        .init(status: .review, agentReview: .pending, humanReview: .pending, skipAgentReview: false, skipHumanReview: false, output: "Turning it on lands the ticket once its agent review passes"),
        .init(status: .review, agentReview: .changesRequested, humanReview: .pending, skipAgentReview: false, skipHumanReview: nil, output: "Turning it on lands the ticket once its agent review passes"),
        .init(status: .review, agentReview: .approved, humanReview: .pending, skipAgentReview: false, skipHumanReview: false, output: "Turning it on lands the ticket now"),
        .init(status: .review, agentReview: .skipped, humanReview: .pending, skipAgentReview: true, skipHumanReview: false, output: "Turning it on lands the ticket now"),
        .init(status: .review, agentReview: .pending, humanReview: .approved, skipAgentReview: false, skipHumanReview: true, output: "Turning it off waits on your approval again"),
        // Off with an approval a human gave: nothing to undo.
        .init(status: .review, agentReview: .pending, humanReview: .approved, skipAgentReview: false, skipHumanReview: false, output: "Lands as soon as the agent review approves it"),
        // On but the human review isn't approved (e.g. changes requested): falls through.
        .init(status: .review, agentReview: .pending, humanReview: .changesRequested, skipAgentReview: true, skipHumanReview: true, output: "Lands as soon as it's submitted"),
        // Outside review, the pending/approved branches don't apply.
        .init(status: .inProgress, agentReview: .pending, humanReview: .pending, skipAgentReview: false, skipHumanReview: false, output: "Lands as soon as the agent review approves it"),
        .init(status: .done, agentReview: .approved, humanReview: .approved, skipAgentReview: true, skipHumanReview: true, output: "Lands as soon as it's submitted"),
    ]

    @Test(arguments: humanCases)
    func skipHumanReviewHint(_ c: HumanCase) {
        #expect(NewSession.skipHumanReviewHint(
            status: c.status, agentReview: c.agentReview, humanReview: c.humanReview,
            skipAgentReview: c.skipAgentReview, skipHumanReview: c.skipHumanReview
        ) == c.output)
    }

    @Test func humanHintOverloadReadsTheTicket() throws {
        var t = try Fixture.value("protocol", "Ticket", as: [Ticket].self)[0]
        t.status = .review
        t.agentReview = .pending
        t.humanReview = .approved
        t.skipHumanReview = true
        #expect(NewSession.skipHumanReviewHint(t) == "Turning it off waits on your approval again")
        t.humanReview = .pending
        t.skipHumanReview = false
        t.agentReview = .skipped
        #expect(NewSession.skipHumanReviewHint(t) == "Turning it on lands the ticket now")
    }
}
