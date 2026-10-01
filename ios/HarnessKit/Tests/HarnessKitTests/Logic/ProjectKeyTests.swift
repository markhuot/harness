import Foundation
import Testing
@testable import HarnessKit

private struct PreviewInput: Decodable, Sendable {
    let project: ProjectKey.ProjectInfo
    let projects: [ProjectKey.ProjectInfo]
    let tickets: [ProjectKey.TicketInfo]
    let draft: String
}

private struct NativeInput: Decodable, Sendable {
    let project: ProjectKey.ProjectInfo
    let tickets: [ProjectKey.TicketInfo]
}

private struct NativeOutput: Decodable, Sendable, Equatable {
    let id: String
    let suffix: String
    let n: Double
}

@Suite("projectKey.ts parity")
struct ProjectKeyTests {
    @Test(arguments: Fixture.cases("projectKey", "previewProjectKeyCases", input: PreviewInput.self, output: ProjectKey.KeyPreview.self))
    fileprivate func previewProjectKey(_ c: Fixture.Case<PreviewInput, ProjectKey.KeyPreview>) {
        let got = ProjectKey.previewProjectKey(c.input.project, projects: c.input.projects, tickets: c.input.tickets, draft: c.input.draft)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("projectKey", "nativeTicketsCases", input: NativeInput.self, output: [NativeOutput].self))
    fileprivate func nativeTickets(_ c: Fixture.Case<NativeInput, [NativeOutput]>) {
        let got = ProjectKey.nativeTickets(c.input.project, c.input.tickets).map { NativeOutput(id: $0.ticket.id, suffix: $0.suffix, n: $0.n) }
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("projectKey", "formatRunsCases", input: [Double].self, output: String.self))
    func formatRuns(_ c: Fixture.Case<[Double], String>) {
        #expect(ProjectKey.formatRuns(c.input) == c.output)
    }

    /// The Project/Ticket overload maps `externalRef.key` through, so a legacy mirror keeps its key.
    @Test func protocolTypesOverload() throws {
        let project = Project(id: "p1", key: "OLD", name: "Old", path: "/x", nextSeq: 3, useWorktrees: true, requireHumanReview: true, autoComplete: true, createdAt: 0, updatedAt: 0)
        let samples = try Fixture.value("protocol", "Ticket", as: [Ticket].self)
        var native = try #require(samples.first)
        native.id = "t1"
        native.key = "OLD-1"
        native.projectId = "p1"
        native.externalRef = nil
        var mirror = native
        mirror.id = "t2"
        mirror.key = "JIRA-9"
        mirror.externalRef = ExternalRef(source: "jira", key: "JIRA-9")
        let r = ProjectKey.previewProjectKey(project, projects: [project], tickets: [native, mirror], draft: "new")
        #expect(r.renames == [ProjectKey.Rename(from: "OLD-1", to: "NEW-1")])
        #expect(r.kept == ["JIRA-9"])
    }
}
