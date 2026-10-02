import Foundation
import Testing
@testable import HarnessKit

struct BRPredictedKeyInput: Decodable, Sendable {
    let key: String
    let nextSeq: Int
    let taken: [String]
}

struct BRBranchRowsInput: Decodable, Sendable {
    let branches: [BranchInfo]
    let query: String
    let defaultLabel: String
    let newPrefix: String
}

struct BRSamePathInput: Decodable, Sendable {
    let a: String?
    let b: String?
}

struct BRCheckoutBranchInput: Decodable, Sendable {
    let branches: [BranchInfo]
    let projectPath: String?
}

struct BRBranchChoiceInput: Decodable, Sendable {
    let name: String?
    let defaultName: String
    let known: [BranchInfo]
    let checkoutPath: String?
}

struct BRBranchHintInput: Decodable, Sendable {
    let choice: BranchChoice
    let base: String
}

struct BRBranchTicketInput: Decodable, Sendable {
    let ticket: Ticket
    let project: Project?
}

/// `value` encoded, compared key-order-insensitively with the TS output.
func expectJSONMatchesTS<T: Encodable>(_ value: T, _ expected: JSONValue, sourceLocation: SourceLocation = #_sourceLocation) throws {
    let actual = try JSONEncoder().encode(value)
    let wanted = try JSONEncoder().encode(expected)
    #expect(try jsonEqual(actual, wanted), "\(String(decoding: actual, as: UTF8.self)) ≠ \(String(decoding: wanted, as: UTF8.self))", sourceLocation: sourceLocation)
}

@Suite("state/branches.ts parity")
struct BranchRowsTests {
    @Test(arguments: Fixture.cases("stateBranches", "predictedTicketKeyCases", input: BRPredictedKeyInput.self, output: String.self))
    func predictedTicketKey(_ c: Fixture.Case<BRPredictedKeyInput, String>) {
        #expect(Branches.predictedTicketKey(key: c.input.key, nextSeq: c.input.nextSeq, isTaken: c.input.taken.contains) == c.output)
    }

    @Test func predictedTicketKeyForAProject() {
        let project = Project(id: "p1", key: "WEB", name: "web", path: "/w", nextSeq: 4, useWorktrees: true, createdAt: 0, updatedAt: 0)
        #expect(Branches.predictedTicketKey(project) == "WEB-4")
        #expect(Branches.predictedTicketKey(project) { $0 == "WEB-4" } == "WEB-5")
    }

    @Test(arguments: Fixture.cases("stateBranches", "newTicketBranchLabelCases", input: String.self, output: String.self))
    func newTicketBranchLabel(_ c: Fixture.Case<String, String>) {
        #expect(Branches.newTicketBranchLabel(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateBranches", "inheritedBaseLabelCases", input: Branches.ResolvedBaseBranch.self, output: String.self))
    func inheritedBaseLabel(_ c: Fixture.Case<Branches.ResolvedBaseBranch, String>) {
        #expect(Branches.inheritedBaseLabel(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateBranches", "branchRowsCases", input: BRBranchRowsInput.self, output: JSONValue.self))
    func branchRows(_ c: Fixture.Case<BRBranchRowsInput, JSONValue>) throws {
        let rows = Branches.branchRows(c.input.branches, query: c.input.query, defaultLabel: c.input.defaultLabel) { c.input.newPrefix + $0 }
        try expectJSONMatchesTS(rows, c.output)
        // The TS shape decodes back to the same rows.
        let decoded = try JSONDecoder().decode([BranchRow].self, from: JSONEncoder().encode(c.output))
        #expect(decoded == rows)
    }

    @Test(arguments: Fixture.cases("stateBranches", "pickableIdsCases", input: [BranchRow].self, output: [String].self))
    func pickableIds(_ c: Fixture.Case<[BranchRow], [String]>) {
        #expect(Branches.pickableIds(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateBranches", "rowIdCases", input: BranchRow.self, output: String?.self))
    func rowId(_ c: Fixture.Case<BranchRow, String?>) {
        #expect(Branches.rowId(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateBranches", "samePathCases", input: BRSamePathInput.self, output: Bool.self))
    func samePath(_ c: Fixture.Case<BRSamePathInput, Bool>) {
        #expect(Branches.samePath(c.input.a, c.input.b) == c.output)
    }

    @Test(arguments: Fixture.cases("stateBranches", "checkoutBranchCases", input: BRCheckoutBranchInput.self, output: BranchInfo?.self))
    func checkoutBranch(_ c: Fixture.Case<BRCheckoutBranchInput, BranchInfo?>) {
        #expect(Branches.checkoutBranch(c.input.branches, projectPath: c.input.projectPath) == c.output)
    }

    @Test(arguments: Fixture.cases("stateBranches", "branchChoiceCases", input: BRBranchChoiceInput.self, output: JSONValue.self))
    func branchChoice(_ c: Fixture.Case<BRBranchChoiceInput, JSONValue>) throws {
        let choice = Branches.branchChoice(c.input.name, defaultName: c.input.defaultName, known: c.input.known, checkoutPath: c.input.checkoutPath)
        try expectJSONMatchesTS(choice, c.output)
        #expect(try JSONDecoder().decode(BranchChoice.self, from: JSONEncoder().encode(c.output)) == choice)
    }

    @Test(arguments: Fixture.cases("stateBranches", "branchChoiceHintCases", input: BRBranchHintInput.self, output: BranchHint.self))
    func branchChoiceHint(_ c: Fixture.Case<BRBranchHintInput, BranchHint>) {
        #expect(Branches.branchChoiceHint(c.input.choice, base: c.input.base) == c.output)
    }

    @Test(arguments: Fixture.cases("stateBranches", "ticketHasBranchCases", input: BRBranchTicketInput.self, output: Bool.self))
    func ticketHasBranch(_ c: Fixture.Case<BRBranchTicketInput, Bool>) {
        #expect(Branches.ticketHasBranch(c.input.ticket, project: c.input.project) == c.output)
    }

    @Test(arguments: Fixture.cases("stateBranches", "canChangeBranchCases", input: BRBranchTicketInput.self, output: Bool.self))
    func canChangeBranch(_ c: Fixture.Case<BRBranchTicketInput, Bool>) {
        #expect(Branches.canChangeBranch(c.input.ticket, project: c.input.project) == c.output)
    }

    @Test func unknownKindsDontDecode() {
        let row = Data(#"{"kind":"weird","value":null,"label":"x"}"#.utf8)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(BranchRow.self, from: row) }
        let choice = Data(#"{"kind":"weird","name":"x"}"#.utf8)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(BranchChoice.self, from: choice) }
    }
}
