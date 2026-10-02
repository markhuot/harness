import Foundation
import Testing
@testable import HarnessKit

/// Outputs are compared as JSON (what the TS sends or renders), so a key that should be omitted, or a
/// label that should be missing, fails the case.
@Suite("approve.ts parity")
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

    struct CompleteMenuInput: Decodable, Sendable {
        let opts: Completion.Options
        let canRun: Bool
    }

    struct ToastInput: Decodable, Sendable {
        let choice: Approve.Choice
        let key: String
    }

    struct OptionsInput: Decodable, Sendable {
        let actions: [CompletionAction]
    }

    struct BodyInput: Decodable, Sendable {
        let choose: Bool
        let action: CompletionAction
        let instructions: String
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
        // And the TS JSON decodes back to the same request.
        #expect(try c.output.decode(as: Approve.Request.self) == got)
    }

    @Test(arguments: Fixture.cases("approve", "primaryApproveRequestCases", input: PrimaryInput.self, output: JSONValue.self))
    func primaryApproveRequest(_ c: Fixture.Case<PrimaryInput, JSONValue>) throws {
        let got = Approve.primaryApproveRequest(c.input.opts, completionAction: c.input.ticket.completionAction, completionInstructions: c.input.ticket.completionInstructions)
        #expect(try Self.json(got) == c.output)
    }

    @Test(arguments: Fixture.cases("approve", "completeMenuChoicesCases", input: CompleteMenuInput.self, output: JSONValue.self))
    func completeMenuChoices(_ c: Fixture.Case<CompleteMenuInput, JSONValue>) throws {
        #expect(try Self.json(Approve.completeMenuChoices(c.input.opts, canRun: c.input.canRun)) == c.output)
    }

    @Test(arguments: Fixture.cases("approve", "completeMenuRequestCases", input: Approve.Choice.self, output: JSONValue.self))
    func completeMenuRequest(_ c: Fixture.Case<Approve.Choice, JSONValue>) throws {
        #expect(try Self.json(Approve.completeMenuRequest(c.input)) == c.output)
    }

    @Test(arguments: Fixture.cases("approve", "approveToastCases", input: ToastInput.self, output: String.self))
    func approveToast(_ c: Fixture.Case<ToastInput, String>) {
        #expect(Approve.approveToast(c.input.choice, key: c.input.key) == c.output)
    }

    @Test(arguments: Fixture.cases("approve", "completionActionOptionsCases", input: OptionsInput.self, output: JSONValue.self))
    func completionActionOptions(_ c: Fixture.Case<OptionsInput, JSONValue>) throws {
        #expect(try Self.json(Approve.completionActionOptions(c.input.actions)) == c.output)
    }

    @Test(arguments: Fixture.cases("approve", "completeBodyCases", input: BodyInput.self, output: JSONValue.self))
    func completeBody(_ c: Fixture.Case<BodyInput, JSONValue>) throws {
        #expect(try Self.json(Approve.completeBody(choose: c.input.choose, action: c.input.action, instructions: c.input.instructions)) == c.output)
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
