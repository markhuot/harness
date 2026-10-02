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
}
