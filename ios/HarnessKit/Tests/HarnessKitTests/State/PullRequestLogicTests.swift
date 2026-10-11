import Foundation
import Testing
@testable import HarnessKit

@Suite("PullRequestLogic (Details tab pull request list)")
struct PullRequestLogicTests {
    static let one = "https://github.com/o/r/pull/1"
    static let two = "https://github.com/o/r/pull/2"
    static let three = "https://github.com/o/r/pull/3"

    @Test func addingTrimsAndAppends() {
        #expect(PullRequestLogic.adding("  \(Self.two)\n", to: [Self.one]) == .save(UpdateTicketBody(pullRequestUrls: [Self.one, Self.two])))
        #expect(PullRequestLogic.adding("http://h/pull/4", to: []) == .save(UpdateTicketBody(pullRequestUrls: ["http://h/pull/4"])))
    }

    /// The service's rule: an http(s) link with no spaces. Anything else is refused before the save.
    @Test func addingRefusesWhatTheServiceWouldRefuse() {
        let notALink = PullRequestLogic.Edit.invalid("Enter a link that starts with https:// or http://")
        #expect(PullRequestLogic.adding("github.com/o/r/pull/3", to: []) == notALink)
        #expect(PullRequestLogic.adding("ftp://h/pull/3", to: []) == notALink)
        #expect(PullRequestLogic.adding("https://github.com/o/r/pull /3", to: []) == notALink)
        #expect(PullRequestLogic.adding("   ", to: []) == notALink)
        #expect(PullRequestLogic.adding("https://", to: []) == notALink)
    }

    @Test func addingAnExistingLinkIsRefusedNotDuplicated() {
        #expect(PullRequestLogic.adding(" \(Self.one) ", to: [Self.one]) == .invalid("That pull request is already linked"))
    }

    @Test func normalizedTrimsAndKeepsTheFirstOfEachLink() {
        #expect(PullRequestLogic.normalized([" \(Self.two) ", Self.one, Self.two]) == [Self.two, Self.one])
    }

    @Test func removingTakesOneOutAndKeepsTheOrder() {
        #expect(PullRequestLogic.removing(Self.two, from: [Self.one, Self.two, Self.three]) == UpdateTicketBody(pullRequestUrls: [Self.one, Self.three]))
        #expect(PullRequestLogic.removing(Self.one, from: [Self.one]) == UpdateTicketBody(pullRequestUrls: []))
        // A link the list doesn't have leaves it as it is.
        #expect(PullRequestLogic.removing(Self.three, from: [Self.one]) == UpdateTicketBody(pullRequestUrls: [Self.one]))
    }

    /// The PATCH carries pullRequestUrls only when set: [] clears the list, nil leaves it alone.
    @Test func theBodySendsTheListOnlyWhenSet() throws {
        let encoder = JSONEncoder()
        #expect(String(decoding: try encoder.encode(UpdateTicketBody(pullRequestUrls: [])), as: UTF8.self) == #"{"pullRequestUrls":[]}"#)
        #expect(String(decoding: try encoder.encode(UpdateTicketBody(title: "T")), as: UTF8.self) == #"{"title":"T"}"#)
    }
}
