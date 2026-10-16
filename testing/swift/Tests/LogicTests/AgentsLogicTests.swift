import Foundation
import Testing
import HarnessKit

private func agent(_ id: String, description: String = "Find the auth middleware", status: SubagentStatus = .running, result: String? = nil,
                   prompt: String = "Look in src/auth", kind: SubagentKind? = nil, command: String? = nil, started: Double = 0, updated: Double = 0) -> Subagent {
    Subagent(id: id, sessionId: "s", description: description, prompt: prompt, status: status, result: result,
             startedAt: started, updatedAt: updated, kind: kind, command: command.map { .value($0) } ?? .absent)
}

private func output(text: String = "", end: Int = 0, done: Bool = false, available: Bool = true) -> TaskOutputState {
    TaskOutputState(text: text, end: end, size: end, done: done, available: available, truncated: false)
}

@Suite struct AgentsLogicTests {
    @Test func listPutsTheLatestUpdateFirstAndKeepsTiesInOrder() {
        let sorted = AgentsLogic.list([
            agent("old", updated: 1),
            agent("tieA", started: 5, updated: 9),
            agent("tieB", started: 5, updated: 9),
            agent("newer-start", started: 6, updated: 9),
        ])
        #expect(sorted.map(\.id) == ["newer-start", "tieA", "tieB", "old"])
    }

    @Test func previewShowsTheResultOnceFinishedElseThePrompt() {
        #expect(AgentsLogic.preview(agent("a", status: .succeeded, result: "Found it")) == "Found it")
        #expect(AgentsLogic.preview(agent("a", status: .running, result: "partial")) == "Look in src/auth", "a running agent has no report yet")
        #expect(AgentsLogic.preview(agent("a", status: .failed, result: "")) == "Look in src/auth", "an empty result falls back to the prompt")
    }

    @Test func aTaskPreviewIsItsCommandUnlessThatIsAlreadyTheTitle() {
        #expect(AgentsLogic.preview(agent("t", description: "Dev server", kind: .bash, command: " bun dev ")) == "bun dev")
        #expect(AgentsLogic.preview(agent("t", description: "", kind: .bash, command: "bun dev")) == "")
        #expect(AgentsLogic.preview(agent("t", description: "x", kind: .monitor)) == "")
    }

    @Test func rowLabelJoinsTheTitleAndStatus() {
        #expect(AgentsLogic.rowLabel(agent("a")) == "Find the auth middleware, Running")
    }

    @Test func emptyNoteNamesTheKindTheFilterKeeps() {
        #expect(AgentsLogic.emptyNote(.init(agents: true, tasks: false)) == "No sub-agents yet")
        #expect(AgentsLogic.emptyNote(.init(agents: false, tasks: true)) == "No background tasks yet")
    }

    @Test func durationsTickEverySecondOnlyWhileSomethingRuns() {
        #expect(AgentsLogic.tickSeconds(running: true) == 1)
        #expect(AgentsLogic.tickSeconds(running: false) == 60)
    }

    @Test func outputNoteSaysNothingUntilTheFirstReadAndOnceThereIsText() {
        #expect(AgentsLogic.outputNote(nil, running: true) == nil)
        #expect(AgentsLogic.outputNote(output(text: "hello", end: 5), running: true) == nil)
        #expect(AgentsLogic.outputNote(output(available: false), running: true) == "Output isn't available")
    }

    @Test func emptyOutputWaitsOnlyWhileTheTaskRunsAndItsOutputCanGrow() {
        #expect(AgentsLogic.outputNote(output(), running: true) == "Waiting for output…")
        #expect(AgentsLogic.outputNote(output(done: true), running: true) == "No output", "the service's done wins over the task's status")
        #expect(AgentsLogic.outputNote(output(), running: false) == "No output")
    }

    @Test func pollOffsetIsTheEndOfLoadedTextOrTheTailBeforeAny() {
        #expect(AgentsLogic.pollOffset(nil) == nil)
        #expect(AgentsLogic.pollOffset(output(available: false)) == nil)
        #expect(AgentsLogic.pollOffset(output(text: "abc", end: 3)) == 3)
    }

    @Test func pollingStopsWhenTheTaskEndsOrItsOutputIsDone() {
        #expect(AgentsLogic.keepsPolling(.running, nil))
        #expect(AgentsLogic.keepsPolling(.running, output(done: false)))
        #expect(!AgentsLogic.keepsPolling(.running, output(done: true)))
        #expect(!AgentsLogic.keepsPolling(.succeeded, output(done: false)))
        #expect(!AgentsLogic.keepsPolling(nil, nil))
    }

    @Test func markIsGreenForSuccessRedForFailureNeutralOtherwise() {
        #expect(AgentsLogic.mark(.succeeded) == (.green, "check"))
        #expect(AgentsLogic.mark(.failed) == (.red, "x"))
        #expect(AgentsLogic.mark(.stopped) == (.neutral, "stop"))
        #expect(AgentsLogic.mark(.unknown("paused")) == (.neutral, "stop"))
    }
}
