import Testing
@testable import HarnessKit

struct BranchBaseRef: Decodable, Sendable {
    let baseBranch: String?
}

struct BranchParentRef: Decodable, Sendable {
    let branch: String?
    let status: TicketStatus?
}

struct ParentLandingBranchInput: Decodable, Sendable {
    let ticket: BranchBaseRef?
    let parent: BranchParentRef?
}

struct ResolveBaseBranchInput: Decodable, Sendable {
    let ticket: BranchBaseRef?
    let project: BranchBaseRef?
    let settings: BranchBaseRef?
    let parent: BranchParentRef?
}

struct ResolveBaseBranchEntityInput: Decodable, Sendable {
    let ticket: Ticket?
    let project: Project?
    let settings: Settings?
    let parent: Ticket?
}

struct ParentLandingBranchEntityInput: Decodable, Sendable {
    let ticket: Ticket?
    let parent: Ticket?
}

struct PlannedBranchInput: Decodable, Sendable {
    let key: String
    let branch: String?
    let requestedBranch: String?
}

private func scalars(_ s: String?) -> [Unicode.Scalar]? { s.map { Array($0.unicodeScalars) } }

@Suite("branches.ts parity")
struct BranchesTests {
    @Test func defaultBaseBranch() throws {
        #expect(Branches.defaultBaseBranch == (try Fixture.value("branches", "defaultBaseBranch", as: String.self)))
    }

    @Test(arguments: Fixture.cases("branches", "parentLandingBranchCases", input: ParentLandingBranchInput.self, output: String?.self))
    func parentLandingBranch(_ c: Fixture.Case<ParentLandingBranchInput, String?>) {
        let got = Branches.parentLandingBranch(
            ticketBaseBranch: c.input.ticket?.baseBranch, parentBranch: c.input.parent?.branch, parentStatus: c.input.parent?.status
        )
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("branches", "resolveBaseBranchCases", input: ResolveBaseBranchInput.self, output: Branches.ResolvedBaseBranch.self))
    func resolveBaseBranch(_ c: Fixture.Case<ResolveBaseBranchInput, Branches.ResolvedBaseBranch>) {
        let got = Branches.resolveBaseBranch(
            ticket: c.input.ticket?.baseBranch, project: c.input.project?.baseBranch, settings: c.input.settings?.baseBranch,
            parentBranch: c.input.parent?.branch, parentStatus: c.input.parent?.status
        )
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("branches", "resolveBaseBranchEntityCases", input: ResolveBaseBranchEntityInput.self, output: Branches.ResolvedBaseBranch.self))
    func resolveBaseBranchEntities(_ c: Fixture.Case<ResolveBaseBranchEntityInput, Branches.ResolvedBaseBranch>) {
        let got = Branches.resolveBaseBranch(
            ticket: c.input.ticket, project: c.input.project, settingsBaseBranch: c.input.settings?.baseBranch, parent: c.input.parent
        )
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("branches", "parentLandingBranchEntityCases", input: ParentLandingBranchEntityInput.self, output: String?.self))
    func parentLandingBranchEntities(_ c: Fixture.Case<ParentLandingBranchEntityInput, String?>) {
        #expect(Branches.parentLandingBranch(ticket: c.input.ticket, parent: c.input.parent) == c.output)
    }

    @Test(arguments: Fixture.cases("branches", "harnessBranchCases", input: String.self, output: String.self))
    func harnessBranch(_ c: Fixture.Case<String, String>) {
        #expect(scalars(Branches.harnessBranch(c.input)) == scalars(c.output))
    }

    @Test(arguments: Fixture.cases("branches", "plannedBranchCases", input: PlannedBranchInput.self, output: String.self))
    func plannedBranch(_ c: Fixture.Case<PlannedBranchInput, String>) {
        #expect(Branches.plannedBranch(key: c.input.key, branch: c.input.branch, requestedBranch: c.input.requestedBranch) == c.output)
    }

    @Test(arguments: Fixture.cases("branches", "plannedBranchEntityCases", input: Ticket.self, output: String.self))
    func plannedBranchEntities(_ c: Fixture.Case<Ticket, String>) {
        #expect(Branches.plannedBranch(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("branches", "branchNameErrorCases", input: String.self, output: String?.self))
    func branchNameError(_ c: Fixture.Case<String, String?>) {
        #expect(Branches.branchNameError(c.input) == c.output)
    }
}
