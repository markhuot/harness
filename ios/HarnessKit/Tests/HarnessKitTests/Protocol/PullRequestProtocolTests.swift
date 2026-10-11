import Foundation
import Testing
@testable import HarnessKit

@Suite("Ticket.pullRequests decoding")
struct PullRequestProtocolTests {
    /// The protocol sample's ticket as a JSON object, with `edit` applied, back to data.
    static func ticketData(_ edit: (inout [String: Any]) -> Void) throws -> Data {
        let sample = try Fixture.value("protocol", "Ticket", as: [Ticket].self)[0]
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sample)) as! [String: Any]
        edit(&object)
        return try JSONSerialization.data(withJSONObject: object)
    }

    static func decode(_ data: Data) throws -> Ticket {
        try JSONDecoder().decode(Ticket.self, from: data)
    }

    @Test func decodesTheListInOrderWithNullTitles() throws {
        let ticket = try Self.decode(Self.ticketData { $0["pullRequests"] = [
            ["url": "https://github.com/o/r/pull/1", "title": "Split the secrets"],
            ["url": "https://github.com/o/r/pull/2", "title": NSNull()],
        ] })
        #expect(ticket.pullRequests == [
            PullRequestLink(url: "https://github.com/o/r/pull/1", title: "Split the secrets"),
            PullRequestLink(url: "https://github.com/o/r/pull/2", title: nil),
        ])
    }

    /// Older services leave the key out: the ticket still decodes, with no pull requests.
    @Test func aMissingOrNullListIsEmpty() throws {
        #expect(try Self.decode(Self.ticketData { $0["pullRequests"] = nil }).pullRequests == [])
        #expect(try Self.decode(Self.ticketData { $0["pullRequests"] = NSNull() }).pullRequests == [])
    }

    @Test func thePreviousSingleLinkStillDecodes() throws {
        let ticket = try Self.decode(Self.ticketData { $0["pullRequestUrl"] = "https://github.com/o/r/pull/9" })
        #expect(ticket.pullRequestUrl.optional == "https://github.com/o/r/pull/9")
    }

    @Test func theListGoesBackOutAsAnArray() throws {
        var ticket = try Self.decode(Self.ticketData { $0["pullRequests"] = [] })
        ticket.pullRequests = [PullRequestLink(url: "https://github.com/o/r/pull/3")]
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ticket)) as? [String: Any]
        let encoded = object?["pullRequests"] as? [[String: Any]]
        #expect(encoded?.first?["url"] as? String == "https://github.com/o/r/pull/3")
        #expect(try Self.decode(JSONEncoder().encode(ticket)) == ticket)
    }
}
