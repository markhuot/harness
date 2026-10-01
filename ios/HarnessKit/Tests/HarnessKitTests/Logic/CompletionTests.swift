import Foundation
import Testing
@testable import HarnessKit

@Suite("completion.ts parity")
struct CompletionTests {
    struct OptionsInput: Decodable, Sendable {
        let ticket: Completion.TicketInfo?
        let project: Completion.ProjectInfo?
        let parent: Completion.ParentInfo?
    }

    struct ResolveInput: Decodable, Sendable {
        let requested: CompletionAction?
        let ticket: Completion.TicketInfo?
        let project: Completion.ProjectInfo?
        let parent: Completion.ParentInfo?
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
        let got = Completion.completionOptions(c.input.ticket, c.input.project, parent: c.input.parent)
        #expect(got == c.output)
        // parentBranch: null is always sent, like the TS object.
        let json = try #require(String(data: JSONEncoder().encode(got), encoding: .utf8))
        #expect(json.contains("\"parentBranch\""))
    }

    @Test(arguments: Fixture.cases("completion", "approveLabelCases", input: OptionsInput.self, output: String?.self))
    func approveLabel(_ c: Fixture.Case<OptionsInput, String?>) {
        #expect(Completion.approveLabel(Completion.completionOptions(c.input.ticket, c.input.project, parent: c.input.parent)) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "approveMenuActionsCases", input: OptionsInput.self, output: [CompletionAction].self))
    func approveMenuActions(_ c: Fixture.Case<OptionsInput, [CompletionAction]>) {
        #expect(Completion.approveMenuActions(Completion.completionOptions(c.input.ticket, c.input.project, parent: c.input.parent)) == c.output)
    }

    @Test(arguments: Fixture.cases("completion", "resolveCompletionActionCases", input: ResolveInput.self, output: Completion.Resolution.self))
    func resolveCompletionAction(_ c: Fixture.Case<ResolveInput, Completion.Resolution>) {
        #expect(Completion.resolveCompletionAction(c.input.requested, c.input.ticket, c.input.project, parent: c.input.parent) == c.output)
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
        let project = Project(id: "p", key: "P", name: "p", path: "/p", nextSeq: 1, useWorktrees: true, isGit: true, requireHumanReview: true, autoComplete: false, completionAction: .pr, pullRequestHost: .value("github.com"), createdAt: 0, updatedAt: 0)
        let parent = Ticket(id: "a", key: "P-1", projectId: "p", title: "a", description: "", status: .inProgress, sessionId: "s", driver: "d", branch: "harness/p-1", createdAt: 0, updatedAt: 0)
        let child = Ticket(id: "b", key: "P-2", projectId: "p", title: "b", description: "", status: .review, sessionId: "s", driver: "d", createdAt: 0, updatedAt: 0)
        #expect(Completion.completionOptions(ticket: child, project: project, parent: parent) == Completion.Options(actions: [.merge], defaultAction: .merge, parentBranch: "harness/p-1"))
        var opened = child
        opened.pullRequestUrl = .value("https://github.com/o/r/pull/1")
        var mergeProject = project
        mergeProject.completionAction = .merge
        #expect(Completion.completionOptions(ticket: opened, project: mergeProject).defaultAction == .pr)
    }
}
