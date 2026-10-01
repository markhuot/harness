import Foundation
import Testing
@testable import HarnessKit

@Suite("related.ts parity")
struct RelatedTests {
    struct RelatedInput: Decodable, Sendable {
        let tickets: [Ticket]
        let ticket: Ticket
        let fetched: [RelatedTicket]?
    }

    struct ErrorInput: Decodable, Sendable {
        let status: Int?
        let message: String?
        let data: JSONValue?
        let plain: String?
        /// `data: undefined` and a missing key are the same in TS; `data: null` decodes as JSONValue.null.
        private enum CodingKeys: String, CodingKey { case status, message, data, plain }
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            status = try c.decodeIfPresent(Int.self, forKey: .status)
            message = try c.decodeIfPresent(String.self, forKey: .message)
            data = c.contains(.data) ? try c.decode(JSONValue.self, forKey: .data) : nil
            plain = try c.decodeIfPresent(String.self, forKey: .plain)
        }
    }

    struct PlainError: Error {}

    struct Current: Decodable, Sendable {
        let key: String
        let url: String?
    }

    struct PatchInput: Decodable, Sendable {
        struct Typed: Decodable, Sendable { let key: String; let url: String }
        let current: Current?
        let input: Typed
    }

    struct DepInput: Decodable, Sendable {
        struct Dep: Decodable, Sendable { let key: String; let missing: Bool? }
        let dep: Dep
        let byRemoteKey: [String: [RelatedTicket]]
    }

    @Test(arguments: Fixture.cases("related", "relatedOfCases", input: RelatedInput.self, output: [RelatedTicket].self))
    func relatedOf(_ c: Fixture.Case<RelatedInput, [RelatedTicket]>) {
        let got = Related.relatedOf(c.input.tickets, c.input.ticket, fetched: c.input.fetched)
        #expect(got == c.output)
        // Swift's == on String merges canonically equivalent keys; check the code points too.
        #expect(got.map { Array($0.key.unicodeScalars) } == c.output.map { Array($0.key.unicodeScalars) })
    }

    @Test(arguments: Fixture.cases("related", "relatedLabelCases", input: RelatedTicket.self, output: String.self))
    func relatedLabel(_ c: Fixture.Case<RelatedTicket, String>) {
        #expect(Related.relatedLabel(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("related", "remoteMatchesOfCases", input: ErrorInput.self, output: RemoteKeyMatches?.self))
    func remoteMatchesOf(_ c: Fixture.Case<ErrorInput, RemoteKeyMatches?>) throws {
        let error: any Error = if c.input.plain != nil { PlainError() } else {
            HarnessAPIError(status: try #require(c.input.status), message: c.input.message ?? "", data: c.input.data)
        }
        #expect(Related.remoteMatchesOf(error) == c.output)
    }

    @Test(arguments: Fixture.cases("related", "remoteIdPatchCases", input: PatchInput.self, output: Related.RemoteIdPatch?.self))
    func remoteIdPatch(_ c: Fixture.Case<PatchInput, Related.RemoteIdPatch?>) throws {
        let current = c.input.current.map { (key: $0.key, url: $0.url) }
        let got = Related.remoteIdPatch(current: current, key: c.input.input.key, url: c.input.input.url)
        #expect(got == c.output)
        // The encoded patch is what TS sends (externalRef: null to unlink, url: null kept).
        if let got {
            let ours = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(got))
            let theirs = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(c.output))
            #expect(ours == theirs)
        }
    }

    @Test(arguments: Fixture.cases("related", "depOpensCases", input: DepInput.self, output: Bool.self))
    func depOpens(_ c: Fixture.Case<DepInput, Bool>) {
        #expect(Related.depOpens(key: c.input.dep.key, missing: c.input.dep.missing, byRemoteKey: c.input.byRemoteKey) == c.output)
    }

    /// The patch maps onto UpdateTicketBody's externalRef: unlink is an explicit null, a link without a
    /// URL sends url: null, and an error sends nothing.
    @Test func externalRefInput() throws {
        #expect(Related.RemoteIdPatch.unlink.externalRefInput == .null)
        #expect(Related.RemoteIdPatch.error("x").externalRefInput == nil)
        let link = try #require(Related.RemoteIdPatch.link(key: "MH-62", url: nil).externalRefInput)
        let body = UpdateTicketBody(externalRef: link)
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(body))
        #expect(json["externalRef"] == .object(["key": .string("MH-62"), "url": .null]))
    }

    /// The dictionary overload sees the same tickets (order only matters for ties).
    @Test func dictionaryOverload() throws {
        let c = try #require(Fixture.cases("related", "relatedOfCases", input: RelatedInput.self, output: [RelatedTicket].self).first { $0.name.hasPrefix("a native key") })
        let map = Dictionary(uniqueKeysWithValues: c.input.tickets.map { ($0.id, $0) })
        #expect(Related.relatedOf(map, c.input.ticket, fetched: c.input.fetched) == c.output)
    }
}
