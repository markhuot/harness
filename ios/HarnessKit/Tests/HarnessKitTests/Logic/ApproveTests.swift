import Foundation
import Testing
@testable import HarnessKit

/// Outputs are compared as JSON (the request body sent, or the labels shown), so a key that should be omitted, or a
/// label that should be missing, fails the case.
@Suite("Approve")
struct ApproveTests {
    struct RequestInput: Decodable, Sendable {
        let choice: Approve.Choice
        let instructions: String?
    }

    struct PrimaryTicket: Decodable, Sendable {
        let completionAction: CompletionAction?
        let completionInstructions: String?
    }

    struct PrimaryInput: Decodable, Sendable {
        let opts: Completion.Options
        let ticket: PrimaryTicket
    }

    struct ToastInput: Decodable, Sendable {
        let choice: Approve.Choice
        let key: String
    }

    struct OptionsInput: Decodable, Sendable {
        let actions: [CompletionAction]
    }

    static func json(_ value: some Encodable) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    @Test(arguments: Fixture.cases("approve", "approveMenuChoicesCases", input: Completion.Options.self, output: JSONValue.self))
    func approveMenuChoices(_ c: Fixture.Case<Completion.Options, JSONValue>) throws {
        #expect(try Self.json(Approve.approveMenuChoices(c.input)) == c.output)
    }

    @Test(arguments: Fixture.cases("approve", "approveRequestCases", input: RequestInput.self, output: JSONValue.self))
    func approveRequest(_ c: Fixture.Case<RequestInput, JSONValue>) throws {
        let got = Approve.approveRequest(c.input.choice, instructions: c.input.instructions)
        #expect(try Self.json(got) == c.output)
        // And the fixture's JSON decodes back to the same request.
        #expect(try c.output.decode(as: Approve.Request.self) == got)
    }

    @Test(arguments: Fixture.cases("approve", "primaryApproveRequestCases", input: PrimaryInput.self, output: JSONValue.self))
    func primaryApproveRequest(_ c: Fixture.Case<PrimaryInput, JSONValue>) throws {
        let got = Approve.primaryApproveRequest(c.input.opts, completionAction: c.input.ticket.completionAction, completionInstructions: c.input.ticket.completionInstructions)
        #expect(try Self.json(got) == c.output)
    }

    @Test(arguments: Fixture.cases("approve", "approveToastCases", input: ToastInput.self, output: String.self))
    func approveToast(_ c: Fixture.Case<ToastInput, String>) {
        #expect(Approve.approveToast(c.input.choice, key: c.input.key) == c.output)
    }

    @Test(arguments: Fixture.cases("approve", "completionActionOptionsCases", input: OptionsInput.self, output: JSONValue.self))
    func completionActionOptions(_ c: Fixture.Case<OptionsInput, JSONValue>) throws {
        #expect(try Self.json(Approve.completionActionOptions(c.input.actions)) == c.output)
    }

    @Test func namesMatchTS() throws {
        let names = try Fixture.value("approve", "names", as: [String: String].self)
        #expect(Set(names.keys) == Set(CompletionAction.allKnown.map(\.rawValue)))
        for (raw, name) in names {
            #expect(Approve.completionActionNames[CompletionAction(rawValue: raw)] == name)
        }
    }

    /// "none" is the no-action row even though CompletionAction would decode it as `.unknown("none")`.
    @Test func noneIsNotAnAction() throws {
        #expect(try JSONValue.string("none").decode(as: Approve.Choice.self) == .none)
        #expect(try JSONValue.string("merge").decode(as: Approve.Choice.self) == .action(.merge))
        #expect(throws: DecodingError.self) { try JSONValue.object(["via": .string("other"), "body": .object([:])]).decode(as: Approve.Request.self) }
    }
}
