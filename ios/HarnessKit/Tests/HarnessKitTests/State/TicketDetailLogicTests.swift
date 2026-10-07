import Foundation
import Testing
@testable import HarnessKit

@Suite("Ticket detail logic")
struct TicketDetailLogicTests {
    static func ticket(_ status: TicketStatus, externalRef: ExternalRef? = nil, completionAction: Patch<CompletionAction> = .absent,
                       completionInstructions: Patch<String> = .absent) -> Ticket {
        Ticket(id: "t1", key: "GREET-1", projectId: "p1", title: "Hi", spec: "", status: status, sessionId: "s1", driver: "dummy",
               externalRef: externalRef, completionAction: completionAction, completionInstructions: completionInstructions,
               createdAt: 1, updatedAt: 1)
    }

    static func run(_ id: String, createdAt: Double, startedAt: Double? = nil, endedAt: Double? = nil, error: String? = nil,
                    prompt: String = "Do it", sessionId: String = "s1") -> Run {
        Run(id: id, sessionId: sessionId, kind: .work, status: .succeeded, driver: "dummy", prompt: prompt, error: error,
            createdAt: createdAt, startedAt: startedAt, endedAt: endedAt)
    }

    @Test("Mark done is offered everywhere but review and done", arguments: [
        (TicketStatus.planning, true), (.inProgress, true), (.blocked, true), (.review, false), (.done, false),
    ])
    func markDone(_ status: TicketStatus, _ offered: Bool) {
        #expect(TicketDetailLogic.offersMarkDone(Self.ticket(status)) == offered)
    }

    @Test("pull request numbers come from /pull/<digits> only")
    func pullRequest() {
        #expect(TicketDetailLogic.pullRequestNumber("https://github.com/o/r/pull/42") == "42")
        #expect(TicketDetailLogic.pullRequestNumber("https://github.com/o/r/pull/42/files") == "42")
        #expect(TicketDetailLogic.pullRequestNumber("https://github.com/o/r/pull/") == nil)
        #expect(TicketDetailLogic.pullRequestNumber("https://gitlab.com/o/r/-/merge_requests/7") == nil)
        // The first /pull/ without digits doesn't stop the search.
        #expect(TicketDetailLogic.pullRequestNumber("https://x/pull/new/pull/9") == "9")
        #expect(TicketDetailLogic.pullRequestBadge("https://github.com/o/r/pull/42") == "PR #42")
        #expect(TicketDetailLogic.pullRequestBadge("https://example.com/review") == "Pull request")
        #expect(TicketDetailLogic.pullRequestShort("https://github.com/o/r/pull/42") == "github.com/o/r/pull/42")
        #expect(TicketDetailLogic.pullRequestShort("http://h/pull/1") == "h/pull/1")
        #expect(TicketDetailLogic.pullRequestShort("ftp://h/pull/1") == "ftp://h/pull/1")
    }

    @Test("the Approve button says why it's disabled on a conductor-managed ticket")
    func approveLabel() {
        let reason = Completion.conductorManagedReason(conductorKey: "WEB-1")
        #expect(TicketDetailLogic.approveButtonLabel("Approve and merge", managedReason: reason) == "Approve and merge (Conductor managed: WEB-1 approves and lands this ticket)")
        #expect(TicketDetailLogic.approveButtonLabel("Approve and merge", managedReason: nil) == "Approve and merge")
    }

    @Test("Approve and… starts from an earlier custom approval's instructions only")
    func approveCustom() {
        #expect(TicketDetailLogic.approveCustomInitial(Self.ticket(.review, completionAction: .value(.custom), completionInstructions: .value("tag it"))) == "tag it")
        #expect(TicketDetailLogic.approveCustomInitial(Self.ticket(.review, completionAction: .value(.merge), completionInstructions: .value("tag it"))) == "")
        #expect(TicketDetailLogic.approveCustomInitial(Self.ticket(.review, completionAction: .value(.custom))) == "")
    }

    @Test("the agent review button")
    func menuText() {
        #expect(TicketDetailLogic.agentReviewButton(.skipped) == "Run agent review")
        #expect(TicketDetailLogic.agentReviewButton(.changesRequested) == "Re-run agent review")
    }

    @Test("approval card lines fall back in order")
    func approval() {
        var a = PendingApproval(id: "a", runId: "r", toolName: "Bash", input: .object([:]), requestedAt: 0)
        #expect(TicketDetailLogic.approvalSubtitle(a, description: "List files") == "List files")
        #expect(TicketDetailLogic.approvalSubtitle(a, description: nil) == "Approve to let this run continue.")
        a.summary = "Runs ls"
        #expect(TicketDetailLogic.approvalSubtitle(a, description: "List files") == "Runs ls")
        #expect(TicketDetailLogic.approvalReasonSource(.classifier) == "Auto-mode classifier")
        #expect(TicketDetailLogic.approvalReasonSource(.policy) == "Permission policy")
        #expect(TicketDetailLogic.approvalReasonSource(nil) == "Permission policy")
        #expect(TicketDetailLogic.approvalRestToggle(showing: false, hasPrimary: true) == "Show other input")
        #expect(TicketDetailLogic.approvalRestToggle(showing: true, hasPrimary: false) == "Hide input")
        #expect(TicketDetailLogic.approvalRestJSON(["b": .number(1), "a": .string("x")]) == "{\n  \"a\": \"x\",\n  \"b\": 1\n}")
    }

    @Test("runs are this session's, newest first, ties by id")
    func runs() {
        var state = BoardState.initial
        state.runs = [
            "r1": Self.run("r1", createdAt: 10), "r2": Self.run("r2", createdAt: 30), "r3": Self.run("r3", createdAt: 30),
            "x": Self.run("x", createdAt: 99, sessionId: "other"),
        ]
        #expect(TicketDetailLogic.runs(state, sessionId: "s1").map(\.id) == ["r3", "r2", "r1"])
    }

    @Test("a run's time is its duration once it ran, at least a second")
    func runTime() {
        #expect(TicketDetailLogic.runTime(Self.run("r", createdAt: 0, startedAt: 1000, endedAt: 13_400), now: 0) == "12s")
        #expect(TicketDetailLogic.runTime(Self.run("r", createdAt: 0, startedAt: 1000, endedAt: 1100), now: 0) == "1s")
        // Math.round rounds .5 up.
        #expect(TicketDetailLogic.runTime(Self.run("r", createdAt: 0, startedAt: 0.5, endedAt: 2500.5), now: 0) == "3s")
        let queued = Self.run("r", createdAt: 1_000_000, startedAt: 1_000_000)
        #expect(TicketDetailLogic.runTime(queued, now: 1_000_000 + 5 * 60_000) == Format.relativeTime(1_000_000, now: 1_000_000 + 5 * 60_000))
    }

    @Test("a run's detail is its error, else its prompt's first line")
    func runDetail() {
        #expect(TicketDetailLogic.runDetail(Self.run("r", createdAt: 0, error: "exit 1", prompt: "a\nb")) == "exit 1")
        #expect(TicketDetailLogic.runDetail(Self.run("r", createdAt: 0, prompt: "first\nsecond")) == "first")
        #expect(TicketDetailLogic.runDetail(Self.run("r", createdAt: 0, prompt: "")) == "")
    }

    @Test("related heading and counts")
    func details() {
        let jira = ExternalRef(source: "jira", key: "JIRA-62", url: nil)
        #expect(TicketDetailLogic.relatedHeading(Self.ticket(.review, externalRef: jira)) == "Also linked to JIRA-62")
        #expect(TicketDetailLogic.relatedHeading(Self.ticket(.review)) == "Linked to remote ID GREET-1")
        #expect(TicketDetailLogic.waitingOnYou(1) == "1 ticket waiting on you")
        #expect(TicketDetailLogic.waitingOnYou(2) == "2 tickets waiting on you")
        #expect(TicketDetailLogic.remoteIdCount(1) == "One ticket is linked to it.")
        #expect(TicketDetailLogic.remoteIdCount(3) == "3 tickets are linked to it.")
        #expect(TicketDetailLogic.authorLabel(.human) == "You")
        #expect(TicketDetailLogic.authorLabel(.system) == "Harness")
        #expect(TicketDetailLogic.authorLabel(.unknown("bot")) == "Harness")
        #expect(TicketDetailLogic.authorLabel(.agent) == "Agent")
    }

    // MARK: Message attachments

    @Test func attachingIsOffOnlyWhileAnApprovalWaits() {
        var t = Self.ticket(.inProgress)
        #expect(TicketDetailLogic.acceptsMessageAttachments(t))
        t.pendingApproval = PendingApproval(id: "a1", runId: "r1", toolName: "Bash", input: .null, requestedAt: 1)
        #expect(!TicketDetailLogic.acceptsMessageAttachments(t))
    }

    @Test("Send needs text or an attachment, no upload in flight, no send in flight", arguments: [
        // text, attachments, uploading, sending, approval, can send
        ("hi", 0, 0, false, false, true),
        ("  \n ", 0, 0, false, false, false),
        ("", 1, 0, false, false, true),
        ("  ", 2, 0, false, false, true),
        ("hi", 1, 1, false, false, false),
        ("", 1, 1, false, false, false),
        ("hi", 0, 0, true, false, false),
        ("", 1, 0, true, false, false),
        // A waiting approval: a text answer goes, attachments with it don't.
        ("no, use bun", 0, 0, false, true, true),
        ("no, use bun", 1, 0, false, true, false),
    ])
    func canSend(_ text: String, _ attachments: Int, _ uploading: Int, _ sending: Bool, _ approval: Bool, _ expected: Bool) {
        #expect(TicketDetailLogic.canSendMessage(text: text, attachments: attachments, uploading: uploading, sending: sending, approvalPending: approval) == expected)
    }
}
