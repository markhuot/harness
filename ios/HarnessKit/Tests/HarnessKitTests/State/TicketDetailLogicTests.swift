import Foundation
import Testing
@testable import HarnessKit

@Suite("Ticket detail logic")
struct TicketDetailLogicTests {
    static func ticket(_ status: TicketStatus, externalRef: ExternalRef? = nil, completionAction: Patch<CompletionAction> = .absent,
                       completionInstructions: Patch<String> = .absent) -> Ticket {
        Ticket(id: "t1", key: "GREET-1", projectId: "p1", title: "Hi", description: "", status: status, sessionId: "s1", driver: "dummy",
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

    @Test("the Complete button says why it's disabled, readiness first")
    func completeLabel() {
        #expect(TicketDetailLogic.completeButtonLabel(ready: false, busy: true) == "Complete (needs both agent and human approval)")
        #expect(TicketDetailLogic.completeButtonLabel(ready: true, busy: true) == "Complete (an agent run is in progress)")
        #expect(TicketDetailLogic.completeButtonLabel(ready: true, busy: false) == "Complete")
        let reason = Completion.conductorManagedReason(conductorKey: "WEB-1")
        #expect(TicketDetailLogic.completeButtonLabel(ready: false, busy: true, managedReason: reason) == "Complete (Conductor managed: WEB-1 approves and lands this ticket)")
        #expect(TicketDetailLogic.approveButtonLabel("Approve and merge", managedReason: reason) == "Approve and merge (Conductor managed: WEB-1 approves and lands this ticket)")
        #expect(TicketDetailLogic.approveButtonLabel("Approve and merge", managedReason: nil) == "Approve and merge")
    }

    @Test("the Complete sheet offers a choice only when nothing else decides")
    func chooses() {
        let three = Completion.Options(actions: [.merge, .pr, .custom], defaultAction: .merge)
        let one = Completion.Options(actions: [.custom], defaultAction: .custom)
        let child = Completion.Options(actions: [.merge], defaultAction: .merge, parentBranch: "harness/web-1")
        #expect(TicketDetailLogic.completeSheetChooses(ready: true, opts: three))
        #expect(!TicketDetailLogic.completeSheetChooses(ready: false, opts: three))
        #expect(!TicketDetailLogic.completeSheetChooses(ready: true, opts: one))
        #expect(!TicketDetailLogic.completeSheetChooses(ready: true, opts: child))
    }

    @Test("the Complete sheet starts on the menu's action only when the ticket offers it")
    func initialAction() {
        let opts = Completion.Options(actions: [.merge, .custom], defaultAction: .merge)
        #expect(TicketDetailLogic.completeSheetInitial(.custom, opts: opts) == .custom)
        #expect(TicketDetailLogic.completeSheetInitial(.pr, opts: opts) == .merge)
        #expect(TicketDetailLogic.completeSheetInitial(nil, opts: opts) == .merge)
    }

    @Test("the Complete sheet's text says what the chosen action does")
    func completeText() {
        let opts = Completion.Options(actions: [.merge, .pr, .custom], defaultAction: .merge)
        #expect(TicketDetailLogic.completeSheetText(.pr, opts: opts) == "The agent finalizes the work: pushes the branch and opens a pull request, cleans up, and marks the ticket done.")
        #expect(TicketDetailLogic.completeSheetText(.custom, opts: opts).contains("follows your instructions"))
        #expect(TicketDetailLogic.completeSheetText(.cleanup, opts: opts).contains("removes the worktree and the harness branch"))
        #expect(TicketDetailLogic.completeSheetText(.merge, opts: opts).contains("merges the worktree branch"))
    }

    @Test("a custom completion that was chosen needs instructions; whitespace isn't any")
    func canSubmit() {
        #expect(!TicketDetailLogic.completeSheetCanSubmit(action: .custom, explicit: true, instructions: " \u{00A0}\n"))
        #expect(TicketDetailLogic.completeSheetCanSubmit(action: .custom, explicit: true, instructions: "tag it"))
        // Not chosen here: the service keeps the approval's choice and its instructions.
        #expect(TicketDetailLogic.completeSheetCanSubmit(action: .custom, explicit: false, instructions: ""))
        #expect(TicketDetailLogic.completeSheetCanSubmit(action: .merge, explicit: true, instructions: ""))
    }

    @Test("Approve and… starts from an earlier custom approval's instructions only")
    func approveCustom() {
        #expect(TicketDetailLogic.approveCustomInitial(Self.ticket(.review, completionAction: .value(.custom), completionInstructions: .value("tag it"))) == "tag it")
        #expect(TicketDetailLogic.approveCustomInitial(Self.ticket(.review, completionAction: .value(.merge), completionInstructions: .value("tag it"))) == "")
        #expect(TicketDetailLogic.approveCustomInitial(Self.ticket(.review, completionAction: .value(.custom))) == "")
    }

    @Test("the Complete menu toast and the agent review button")
    func menuText() {
        #expect(TicketDetailLogic.completeMenuToast(.none, label: "GREET-1") == "GREET-1 marked done")
        #expect(TicketDetailLogic.completeMenuToast(.action(.merge), label: "GREET-1") == "Completion run queued")
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

    @Test("related heading, external source and patch toasts")
    func details() {
        let jira = ExternalRef(source: "jira", key: "JIRA-62", url: nil)
        #expect(TicketDetailLogic.relatedHeading(Self.ticket(.review, externalRef: jira)) == "Also linked to JIRA-62")
        #expect(TicketDetailLogic.relatedHeading(Self.ticket(.review)) == "Linked to remote ID GREET-1")
        #expect(TicketDetailLogic.externalSource(jira) == "via jira")
        #expect(TicketDetailLogic.externalSource(ExternalRef(source: "manual", key: "X-1", url: nil)) == "set by hand")
        #expect(TicketDetailLogic.patchToast(UpdateTicketBody(externalRef: .null)) == "Remote ID unlinked")
        #expect(TicketDetailLogic.patchToast(UpdateTicketBody(externalRef: .value(ExternalRefInput(key: "JIRA-9")))) == "Linked to JIRA-9")
        #expect(TicketDetailLogic.patchToast(UpdateTicketBody(title: "x")) == nil)
        #expect(TicketDetailLogic.waitingOnYou(1) == "1 ticket waiting on you")
        #expect(TicketDetailLogic.waitingOnYou(2) == "2 tickets waiting on you")
        #expect(TicketDetailLogic.remoteIdCount(1) == "One ticket is linked to it.")
        #expect(TicketDetailLogic.remoteIdCount(3) == "3 tickets are linked to it.")
        #expect(TicketDetailLogic.authorLabel(.human) == "You")
        #expect(TicketDetailLogic.authorLabel(.system) == "Harness")
        #expect(TicketDetailLogic.authorLabel(.unknown("bot")) == "Harness")
        #expect(TicketDetailLogic.authorLabel(.agent) == "Agent")
    }
}
