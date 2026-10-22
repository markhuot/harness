import Foundation
import Testing
import HarnessKit

private func watcher(_ id: String, command: String = "run", args: [String] = [], mode: WatcherMode = .interval, intervalSec: Int = 300, enabled: Bool = true, cos: Patch<String> = .absent, error: String? = nil, live: WatcherLive? = nil) -> Watcher {
    Watcher(id: id, name: id, command: command, args: args, mode: mode, intervalSec: intervalSec, enabled: enabled, lastError: error, createdAt: 1, updatedAt: 1, cosId: cos, live: live)
}

private let all = Cos(ticketId: "cos-all", key: "COS-1", scope: "all", createdAt: 0)
private let work = Cos(ticketId: "cos-work", key: "COS-2", scope: "group:g1", groupId: "g1", createdAt: 0)

@Suite struct ChiefListenersTests {
    private let list = [
        watcher("b", cos: .value("cos-work")), watcher("a", cos: .value("cos-all")), watcher("orphan"),
        watcher("off", enabled: false, cos: .value("cos-work")), watcher("z", cos: .null),
    ]

    @Test func aGroupsChiefGetsOnlyItsOwnWatchers() {
        #expect(Listeners.forChief(list, chief: work).map(\.id) == ["b", "off"])
        #expect(Listeners.forChief([watcher("x")], chief: work).isEmpty, "a deleted chief's watchers (cosId null) and ones from an older service are not a group chief's")
    }

    @Test func theAllChiefGetsEveryWatcherPausedLastThenByName() {
        #expect(Listeners.forChief(list, chief: all).map(\.id) == ["a", "b", "orphan", "z", "off"])
    }

    @Test func theCommandDropsAssignmentsAndMasksCredentials() {
        #expect(Listeners.command(watcher("a", command: #"TOKEN=abc FOO="a b" watch-jira --project FOO"#)) == "watch-jira --project FOO")
        #expect(Listeners.command(watcher("a", command: "curl -H 'Authorization: Bearer abc123' https://u:pw@host/x")) == "curl -H 'Authorization: ***' https://u:***@host/x")
        #expect(Listeners.command(watcher("a", command: "cli --api-key=abc --token xyz --name ok")) == "cli --api-key=*** --token *** --name ok")
        #expect(Listeners.command(watcher("a", command: "env GH_TOKEN=abc gh pr list")) == "env GH_TOKEN=*** gh pr list")
    }

    @Test func aLegacyExecutableReadsAsOneLineAndALoopShowsItsFirstLineCutToLength() {
        #expect(Listeners.command(watcher("a", command: "watch-prs", args: ["--project", "my repo"])) == "watch-prs --project 'my repo'")
        #expect(Listeners.command(watcher("a", command: "while true; do\n\(String(repeating: "x", count: 200))\ndone"), max: 20) == "while true; do")
        #expect(Listeners.command(watcher("a", command: String(repeating: "x", count: 200)), max: 20).count == 20)
    }

    @Test func anErrorIsTheFirstLineMaskedAndShort() {
        #expect(Listeners.error(watcher("a")) == "")
        #expect(Listeners.error(watcher("a", error: "auth failed: Bearer sk-123\nstack…")) == "auth failed: Bearer ***")
        #expect(Listeners.error(watcher("a", error: String(repeating: "e", count: 300))).count == 120)
    }

    @Test func statusAndSchedule() {
        let running = WatcherLive(state: .running, since: 1)
        let waiting = WatcherLive(state: .waiting, since: 1, nextRunAt: 5)
        #expect(Listeners.status(watcher("a", enabled: false, error: "x", live: running)) == .paused)
        #expect(Listeners.status(watcher("a", error: "x", live: running)) == .running)
        #expect(Listeners.status(watcher("a", error: "x", live: waiting)) == .error)
        #expect(Listeners.status(watcher("a")) == .active)
        #expect(Listeners.schedule(watcher("a", intervalSec: 45)) == "Every 45s")
        #expect(Listeners.schedule(watcher("a", intervalSec: 300)) == "Every 5m")
        #expect(Listeners.schedule(watcher("a", intervalSec: 7200)) == "Every 2h")
        #expect(Listeners.schedule(watcher("a", intervalSec: 90)) == "Every 90s")
        #expect(Listeners.schedule(watcher("a", mode: .loop)) == "Runs continuously")
        #expect(Listeners.nextRun(watcher("a", live: waiting)) == 5)
        #expect(Listeners.nextRun(watcher("a", enabled: false, live: waiting)) == nil, "a paused listener has no next run")
    }

    @Test func theOwnerTagNamesAnotherChiefOnly() {
        let name: (String) -> String? = { $0 == "cos-work" ? "Work" : nil }
        #expect(Listeners.owner(watcher("a", cos: .value("cos-work")), viewer: all, chiefName: name) == "Work")
        #expect(Listeners.owner(watcher("a", cos: .value("cos-all")), viewer: all, chiefName: name) == nil)
        #expect(Listeners.owner(watcher("a", cos: .null), viewer: all, chiefName: name) == nil)
    }
}
