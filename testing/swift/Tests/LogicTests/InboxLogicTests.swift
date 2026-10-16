import Foundation
import Testing
import HarnessKit

private func watcher(_ id: String, name: String, enabled: Bool = true, mode: WatcherMode = .interval, intervalSec: Int = 60, live: WatcherLive? = nil) -> Watcher {
    Watcher(id: id, name: name, command: "true", mode: mode, intervalSec: intervalSec, enabled: enabled, createdAt: 0, updatedAt: 0, live: live)
}

private func session(triage: TriageStatus?, outcome: String? = nil) -> Session {
    Session(id: "s", key: "TRIAGE-1", kind: .triage, driver: "claude-code", cwd: "/tmp", triageStatus: triage, outcome: outcome, createdAt: 0, updatedAt: 0)
}

@Suite struct InboxLogicTests {
    @Test func enabledWatchersComeFirstThenByNameThenById() {
        let sorted = InboxLogic.sortedWatchers([
            watcher("3", name: "zeta"),
            watcher("1", name: "alpha", enabled: false),
            watcher("2", name: "beta"),
            watcher("5", name: "beta"),
            watcher("4", name: "beta"),
        ])
        #expect(sorted.map(\.id) == ["2", "4", "5", "3", "1"])
    }

    @Test func scheduleLabelNamesLoopsAndIntervals() {
        #expect(InboxLogic.scheduleLabel(watcher("1", name: "a", mode: .loop, intervalSec: 5)) == "Loop")
        #expect(InboxLogic.scheduleLabel(watcher("1", name: "a", mode: .interval, intervalSec: 90)) == "Every 90s")
    }

    @Test func retryShowsOnlyForAFailedWatcherThatIsNotRunning() {
        let failed = WatcherStatus(label: "Failed", tone: .red, detail: "retrying in 2m", error: "exit 1")
        let healthy = WatcherStatus(label: "Running", tone: .green, detail: "", error: nil)
        let running = WatcherLive(state: .running, since: 0)
        let waiting = WatcherLive(state: .waiting, since: 0)
        #expect(InboxLogic.showsRetry(watcher("1", name: "a", live: waiting), status: failed))
        #expect(InboxLogic.showsRetry(watcher("1", name: "a"), status: failed), "a service that doesn't report the process counts as not running")
        #expect(!InboxLogic.showsRetry(watcher("1", name: "a", live: running), status: failed))
        #expect(!InboxLogic.showsRetry(watcher("1", name: "a", live: waiting), status: healthy))
    }

    @Test func aSessionWithNoTriageStatusReadsAsTriaging() {
        #expect(InboxLogic.triageLabel(session(triage: nil)) == Format.triageLabel[.triaging])
        #expect(InboxLogic.triageLabel(session(triage: .dispatched)).label == "Dispatched")
    }

    @Test func anUnknownTriageStatusKeepsItsRawNameInANeutralBadge() {
        let label = InboxLogic.triageLabel(session(triage: .unknown("snoozed")))
        #expect(label.label == "snoozed")
        #expect(label.tone == .neutral)
    }

    @Test func outcomeStyleIsGreenWhenDispatchedRedWhenFailedElseNeutral() {
        #expect(InboxLogic.outcomeStyle(session(triage: .dispatched)) == (.green, "checkCircle"))
        #expect(InboxLogic.outcomeStyle(session(triage: .failed)) == (.red, "alert"))
        #expect(InboxLogic.outcomeStyle(session(triage: .declined)) == (.neutral, "alert"))
        #expect(InboxLogic.outcomeStyle(session(triage: nil)) == (.neutral, "alert"))
    }

    @Test func fileLinksOpenInTheDispatchedTicketWhenItsProjectIsNotLoaded() {
        let state = BoardState()
        #expect(InboxLogic.linkContext(state, session(triage: .dispatched, outcome: "Dispatched to FOO-123")) == FileLinkContext(ticketKey: "FOO-123"))
        #expect(InboxLogic.linkContext(state, session(triage: .declined, outcome: "Nothing to do")) == FileLinkContext())
        #expect(InboxLogic.dispatchedTicket(state, session(triage: .dispatched, outcome: "Dispatched to FOO-123")) == nil)
    }
}
