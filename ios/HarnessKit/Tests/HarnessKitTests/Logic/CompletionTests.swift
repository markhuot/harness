import Foundation
import Testing
@testable import HarnessKit

@Suite("completion.ts parity")
struct CompletionTests {
    struct OptionsInput: Decodable, Sendable {
        let ticket: Completion.TicketInfo?
        let project: Completion.ProjectInfo?
        let parent: Completion.ParentInfo?
        let base: String?
    }

    struct WorksOnBaseInput: Decodable, Sendable {
        let ticket: Completion.TicketInfo?
        let base: String?
    }

    struct ConductorTicketIn: Decodable, Sendable { let parentId: String? }
    struct ConductorParentIn: Codable, Sendable, Equatable {
        let key: String
        let status: TicketStatus?
    }
    struct ManagingInput: Decodable, Sendable {
        let ticket: ConductorTicketIn?
        let parent: ConductorParentIn?
    }

    struct ResolveInput: Decodable, Sendable {
        let requested: CompletionAction?
        let ticket: Completion.TicketInfo?
        let project: Completion.ProjectInfo?
        let parent: Completion.ParentInfo?
        let base: String?
    }

    struct CompletionLabels: Decodable {
        let COMPLETION_ACTION_LABELS: [String: String]
        let APPROVE_NO_ACTION_LABEL: String
    }

    @Test(arguments: Fixture.cases("completion", "offeredCompletionActionsCases", input: Completion.ProjectInfo?.self, output: [CompletionAction].self))
    func offeredCompletionActions(_ c: Fixture.Case<Completion.ProjectInfo?, [CompletionAction]>) {
        #expect(Completion.offeredCompletionActions(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "isCompletionActionCases", input: JSONValue.self, output: Bool.self))
    func isCompletionAction(_ c: Fixture.Case<JSONValue, Bool>) {
        #expect(Completion.isCompletionAction(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "projectCompletionDefaultCases", input: Completion.ProjectInfo?.self, output: CompletionAction.self))
    func projectCompletionDefault(_ c: Fixture.Case<Completion.ProjectInfo?, CompletionAction>) {
        #expect(Completion.projectCompletionDefault(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "completionOptionsCases", input: OptionsInput.self, output: Completion.Options.self))
    func completionOptions(_ c: Fixture.Case<OptionsInput, Completion.Options>) throws {
        let got = Completion.completionOptions(c.input.ticket, c.input.project, parent: c.input.parent, base: c.input.base)
        #expect(got == c.output)
        // parentBranch: null is always sent, like the TS object.
        let json = try #require(String(data: JSONEncoder().encode(got), encoding: .utf8))
        #expect(json.contains("\"parentBranch\""))
    }

    @Test(arguments: Fixture.cases("completion", "approveLabelCases", input: OptionsInput.self, output: String?.self))
    func approveLabel(_ c: Fixture.Case<OptionsInput, String?>) {
        #expect(Completion.approveLabel(Completion.completionOptions(c.input.ticket, c.input.project, parent: c.input.parent, base: c.input.base)) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "worksOnBaseCases", input: WorksOnBaseInput.self, output: Bool.self))
    func worksOnBase(_ c: Fixture.Case<WorksOnBaseInput, Bool>) {
        #expect(Completion.worksOnBase(c.input.ticket, base: c.input.base) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "hasNoBranchCases", input: Completion.TicketInfo?.self, output: Bool.self))
    func hasNoBranch(_ c: Fixture.Case<Completion.TicketInfo?, Bool>) {
        #expect(Completion.hasNoBranch(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "managingConductorCases", input: ManagingInput.self, output: ConductorParentIn?.self))
    func managingConductor(_ c: Fixture.Case<ManagingInput, ConductorParentIn?>) {
        let key = Completion.managingConductor(parentId: c.input.ticket?.parentId, parentKey: c.input.parent?.key, parentStatus: c.input.parent?.status)
        #expect(key == c.output?.key)
    }

    @Test(arguments: Fixture.cases("completion", "conductorManagedReasonCases", input: ConductorParentIn.self, output: String.self))
    func conductorManagedReason(_ c: Fixture.Case<ConductorParentIn, String>) {
        #expect(Completion.conductorManagedReason(conductorKey: c.input.key) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "resolveCompletionActionCases", input: ResolveInput.self, output: Completion.Resolution.self))
    func resolveCompletionAction(_ c: Fixture.Case<ResolveInput, Completion.Resolution>) {
        #expect(Completion.resolveCompletionAction(c.input.requested, c.input.ticket, c.input.project, parent: c.input.parent, base: c.input.base) == c.output)
    }

    @Test func labelsMatchTS() throws {
        let labels = try Fixture.value("completion", "labels", as: CompletionLabels.self)
        #expect(labels.APPROVE_NO_ACTION_LABEL == Completion.approveNoActionLabel)
        #expect(Set(labels.COMPLETION_ACTION_LABELS.keys) == Set(CompletionAction.allKnown.map(\.rawValue)))
        for (raw, label) in labels.COMPLETION_ACTION_LABELS {
            #expect(Completion.label(for: CompletionAction(rawValue: raw)) == label)
        }
    }

    /// The entity overload reads the same fields as the TS shapes: a child of a branch-owning parent,
    /// and Patch fields on Ticket/Project.
    @Test func entityOverload() {
        let project = Project(id: "p", key: "P", name: "p", path: "/p", nextSeq: 1, useWorktrees: true, isGit: true, requireHumanReview: true, completionAction: .pr, pullRequestHost: .value("github.com"), createdAt: 0, updatedAt: 0)
        let parent = Ticket(id: "a", key: "P-1", projectId: "p", title: "a", description: "", status: .inProgress, sessionId: "s", driver: "d", branch: "harness/p-1", createdAt: 0, updatedAt: 0)
        let child = Ticket(id: "b", key: "P-2", projectId: "p", title: "b", description: "", status: .review, sessionId: "s", driver: "d", createdAt: 0, updatedAt: 0)
        #expect(Completion.completionOptions(ticket: child, project: project, parent: parent) == Completion.Options(actions: [.merge], defaultAction: .merge, parentBranch: "harness/p-1"))
        var opened = child
        opened.branch = "harness/p-2"
        opened.pullRequestUrl = .value("https://github.com/o/r/pull/1")
        var mergeProject = project
        mergeProject.completionAction = .merge
        #expect(Completion.completionOptions(ticket: opened, project: mergeProject).defaultAction == .pr)
        // A ticket with no branch of its own (it worked in the project checkout) drops merge and pr.
        #expect(Completion.completionOptions(ticket: child, project: project) == Completion.Options(actions: [.cleanup, .custom], defaultAction: .cleanup))
        // A ticket whose branch is its effective base (here the settings' default) drops merge and pr.
        var onBase = child
        onBase.branch = "release"
        #expect(Completion.completionOptions(ticket: onBase, project: project, settingsBaseBranch: "release").actions == [.cleanup, .custom])
        #expect(Completion.completionOptions(ticket: onBase, project: project, settingsBaseBranch: "main").actions == [.merge, .pr, .cleanup, .custom])
        // The parent manages its child until it's done.
        #expect(Completion.managingConductor(ticket: Self.withParent(child), parent: parent)?.key == "P-1")
        var doneParent = parent
        doneParent.status = .done
        #expect(Completion.managingConductor(ticket: Self.withParent(child), parent: doneParent) == nil)
        #expect(Completion.managingConductor(ticket: child, parent: parent) == nil)
    }

    private static func withParent(_ t: Ticket) -> Ticket {
        var t = t
        t.parentId = "a"
        return t
    }
}
