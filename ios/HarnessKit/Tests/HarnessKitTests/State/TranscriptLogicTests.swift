import Foundation
import Testing
@testable import HarnessKit

@Suite("Transcript, Inbox and Agents logic")
struct TranscriptLogicTests {
    static func entry(_ id: String, _ content: TranscriptContent, seq: Int = 0) -> TranscriptEntry {
        TranscriptEntry(id: id, sessionId: "s1", seq: seq, role: .assistant, content: content, createdAt: 1)
    }

    static func agent(_ id: String, _ status: SubagentStatus, result: String? = nil, prompt: String = "Look around",
                      description: String = "Survey", startedAt: Double = 0, endedAt: Double? = nil) -> Subagent {
        Subagent(id: id, sessionId: "s1", description: description, prompt: prompt, status: status, result: result,
                 startedAt: startedAt, endedAt: endedAt, updatedAt: 0)
    }

    static func watcher(_ id: String, _ name: String, enabled: Bool = true, mode: WatcherMode = .loop, lastError: String? = nil,
                        live: WatcherLive? = nil) -> Watcher {
        Watcher(id: id, name: name, command: "true", mode: mode, intervalSec: 90, enabled: enabled, lastError: lastError,
                createdAt: 0, updatedAt: 0, live: live)
    }

    static func session(busy: Bool = false, triage: TriageStatus? = nil, outcome: String? = nil) -> Session {
        Session(id: "s1", key: "TRIAGE-1", kind: .triage, driver: "dummy", cwd: "/", title: "Item", triageStatus: triage, outcome: outcome,
                busy: busy, createdAt: 0, updatedAt: 0)
    }

    // MARK: Rows

    @Test("Working… shows only while busy with nothing streaming, after the entries")
    func workingRow() {
        let items = Format.groupTranscript([Self.entry("e1", .text(text: "hi"))])
        #expect(TranscriptLogic.rows(items: items, deltas: [], working: true).map(\.id) == ["e1", "working"])
        #expect(TranscriptLogic.rows(items: items, deltas: [], working: false).map(\.id) == ["e1"])
        let streaming = TranscriptLogic.rows(items: items, deltas: [LiveDelta(runId: "r1", text: "Hel")], working: true)
        #expect(streaming == [.item(items[0]), .delta(runId: "r1", text: "Hel")])
    }

    @Test("the window keeps the newest rows and counts the rest")
    func window() {
        let rows = (0..<5).map { TranscriptLogic.Row.delta(runId: "r\($0)", text: "") }
        let w = TranscriptLogic.window(rows, limit: 3)
        #expect(w.rows.map(\.id) == ["delta-r2", "delta-r3", "delta-r4"])
        #expect(w.hidden == 2)
        #expect(TranscriptLogic.window(rows, limit: 5).hidden == 0)
        #expect(TranscriptLogic.window(rows, limit: 99).rows.count == 5)
        #expect(TranscriptLogic.window(rows, limit: 0).rows.isEmpty)
        #expect(TranscriptLogic.window([], limit: 3).hidden == 0)
    }

    @Test("entries that draw nothing get no row")
    func silentEntries() {
        let unknown = Self.entry("u", .unknown(type: "future", raw: .object(["type": .string("future")])))
        let items: [Format.TranscriptItem] = [.entry(unknown), .entry(Self.entry("c", .toolCall(callId: "k", name: "x", input: .null))),
                                              .entry(Self.entry("s", .status(text: "Run started (work)")))]
        #expect(TranscriptLogic.rows(items: items, deltas: [], working: false).map(\.id) == ["s"])
    }

    @Test("a tool call and its result are one row whose id is the call's")
    func toolPairing() {
        let call = Self.entry("c", .toolCall(callId: "k1", name: "Bash", input: .object(["command": .string("ls")])), seq: 1)
        let result = Self.entry("r", .toolResult(callId: "k1", name: "Bash", output: [], isError: true), seq: 2)
        let orphan = Self.entry("o", .toolResult(callId: "gone", name: "Read", output: [], isError: false), seq: 3)
        let rows = TranscriptLogic.rows(items: Format.groupTranscript([call, result, orphan]), deltas: [], working: false)
        #expect(rows.map(\.id) == ["c", "o"])
        #expect(TranscriptLogic.toolState(result: result) == .failed)
        #expect(TranscriptLogic.toolState(result: orphan) == .ok)
        #expect(TranscriptLogic.toolState(result: nil) == .running)
        // An orphan result names the row by its own tool.
        #expect(TranscriptLogic.toolName(call: nil, result: orphan) == "Read")
        #expect(TranscriptLogic.toolName(call: nil, result: nil) == "tool")
    }

    @Test("sub-agents don't stream, and work while they run")
    func subagentScope() {
        var state = BoardState()
        state.sessions["s1"] = Self.session(busy: true)
        state.deltas["s1"] = ["r1": "partial"]
        state.subagents["s1"] = [Self.agent("a1", .succeeded), Self.agent("a2", .running)]
        #expect(TranscriptLogic.deltas(state, sessionId: "s1", subagentId: nil) == [LiveDelta(runId: "r1", text: "partial")])
        #expect(TranscriptLogic.deltas(state, sessionId: "s1", subagentId: "a2").isEmpty)
        #expect(TranscriptLogic.working(state, sessionId: "s1", subagentId: nil))
        #expect(!TranscriptLogic.working(state, sessionId: "s1", subagentId: "a1"))
        #expect(TranscriptLogic.working(state, sessionId: "s1", subagentId: "a2"))
        #expect(!TranscriptLogic.working(state, sessionId: "s1", subagentId: "missing"))
        #expect(!TranscriptLogic.working(state, sessionId: "nope", subagentId: nil))
    }

    @Test("a tool call links to the sub-agent whose id is its callId")
    func agentForCall() {
        let agents = [Self.agent("k1", .running)]
        let call = Self.entry("c", .toolCall(callId: "k1", name: "Task", input: .null))
        let other = Self.entry("d", .toolCall(callId: "k2", name: "Task", input: .null))
        #expect(TranscriptLogic.agent(for: call, in: agents)?.id == "k1")
        #expect(TranscriptLogic.agent(for: other, in: agents) == nil)
        #expect(TranscriptLogic.agent(for: call, in: nil) == nil)
        #expect(TranscriptLogic.agent(for: Self.entry("t", .text(text: "k1")), in: agents) == nil)
    }

    @Test("a code box's text is cut into runs of lines that join back to the text")
    func codeChunks() {
        let lines = (1...5).map { "line \($0)" }
        // Cut at the boundary, the remainder in its own chunk, and nothing lost or added.
        #expect(TranscriptLogic.codeChunks(lines.joined(separator: "\n"), lines: 2) == ["line 1\nline 2", "line 3\nline 4", "line 5"])
        #expect(TranscriptLogic.codeChunks(lines.prefix(4).joined(separator: "\n"), lines: 2) == ["line 1\nline 2", "line 3\nline 4"])
        // Blank lines (and a trailing newline) survive the round trip.
        let blanks = "a\n\n\nb\n"
        #expect(TranscriptLogic.codeChunks(blanks, lines: 2).joined(separator: "\n") == blanks)
        #expect(TranscriptLogic.codeChunks(blanks, lines: 2) == ["a\n", "\nb", ""])
        #expect(TranscriptLogic.codeChunks("") == [""])
        #expect(TranscriptLogic.codeChunks("one", lines: 0) == ["one"])
    }

    @Test("a line past the width is broken into pieces, which count toward the chunk's lines")
    func codeChunksBreakLongLines() {
        #expect(TranscriptLogic.codeChunks("abcdefg\nhi", lines: 10, width: 3) == ["abc\ndef\ng\nhi"])
        #expect(TranscriptLogic.codeChunks("abcdef", lines: 10, width: 3) == ["abc\ndef"])
        #expect(TranscriptLogic.codeChunks("abc", lines: 10, width: 3) == ["abc"])
        #expect(TranscriptLogic.codeChunks("abcdefg\nhi", lines: 2, width: 3) == ["abc\ndef", "g\nhi"])
        // A capped tool output with a spec on one line: no chunk is past the limits.
        let output = "{\n  \"spec\": \"" + String(repeating: "x", count: 9500) + "\"\n}"
        let chunks = TranscriptLogic.codeChunks(output)
        #expect(chunks.joined().filter { $0 == "x" }.count == 9500)
        for chunk in chunks {
            let rows = chunk.split(separator: "\n", omittingEmptySubsequences: false)
            #expect(rows.count <= TranscriptLogic.codeChunkLines)
            #expect(rows.allSatisfy { $0.count <= TranscriptLogic.codeLineLimit })
        }
    }

    @Test("the Input block is JSON.stringify(input, null, 2)")
    func inputJSON() {
        #expect(TranscriptLogic.inputJSON(.object(["command": .string("ls -la")])) == "{\n  \"command\": \"ls -la\"\n}")
        #expect(TranscriptLogic.inputJSON(.null) == "null")
    }

    @Test("permission rows: edge tone per decision, footer with and without a time")
    func permission() {
        #expect(TranscriptLogic.decisionTone(.allow) == .green)
        #expect(TranscriptLogic.decisionTone(.ask) == .amber)
        #expect(TranscriptLogic.decisionTone(.deny) == .red)
        #expect(TranscriptLogic.decisionTone(.unknown("later")) == .red)
        let log = PermissionDecisionLog(tool: "Bash", summary: "ls", decision: .allow, reason: "", source: .policy, mode: .auto)
        let base = "\(Format.decisionSource(log)) · auto mode"
        #expect(TranscriptLogic.permissionFooter(log, time: nil) == base)
        #expect(TranscriptLogic.permissionFooter(log, time: "3:04 PM") == base + " · 3:04 PM")
    }

    // MARK: Inbox

    @Test("watchers: enabled first, then by name")
    func watcherOrder() {
        let list = [Self.watcher("1", "zeta"), Self.watcher("2", "alpha", enabled: false), Self.watcher("3", "Beta"), Self.watcher("4", "alpha")]
        #expect(InboxLogic.sortedWatchers(list).map(\.id) == ["4", "3", "1", "2"])
    }

    @Test("schedule badge and Retry now")
    func watcherRow() {
        #expect(InboxLogic.scheduleLabel(Self.watcher("1", "a")) == "Loop")
        #expect(InboxLogic.scheduleLabel(Self.watcher("1", "a", mode: .interval)) == "Every 90s")
        let failed = Self.watcher("1", "a", lastError: "401", live: WatcherLive(state: .waiting, since: 0, nextRunAt: 60_000, failures: 2))
        #expect(InboxLogic.showsRetry(failed, status: Watchers.watcherStatus(failed, now: 1000)))
        // A run in progress hides it even with the last run's error still on record.
        var running = failed
        running.live = WatcherLive(state: .running, since: 0)
        #expect(!InboxLogic.showsRetry(running, status: WatcherStatus(label: "Running", tone: .green, detail: "", error: "401")))
        let fine = Self.watcher("1", "a", live: WatcherLive(state: .waiting, since: 0))
        #expect(!InboxLogic.showsRetry(fine, status: Watchers.watcherStatus(fine, now: 1000)))
    }

    @Test("triage badge and outcome callout per status")
    func triage() {
        #expect(InboxLogic.triageLabel(Self.session()).label == "Triaging")
        #expect(InboxLogic.triageLabel(Self.session(triage: .failed)).tone == .red)
        #expect(InboxLogic.outcomeStyle(Self.session(triage: .dispatched)) == (.green, "checkCircle"))
        #expect(InboxLogic.outcomeStyle(Self.session(triage: .failed)) == (.red, "alert"))
        #expect(InboxLogic.outcomeStyle(Self.session(triage: .declined)) == (.neutral, "alert"))
    }

    @Test("a triage session's links open in the dispatched ticket's project, else by its key")
    func triageLinks() {
        var state = BoardState()
        let s = Self.session(triage: .dispatched, outcome: "Dispatched to GREET-4")
        #expect(InboxLogic.linkContext(state, s) == FileLinkContext(ticketKey: "GREET-4"))
        #expect(InboxLogic.dispatchedTicket(state, s) == nil)
        state.tickets["t4"] = Ticket(id: "t4", key: "GREET-4", projectId: "p9", title: "", spec: "", status: .review, sessionId: "s4",
                                     driver: "dummy", createdAt: 0, updatedAt: 0)
        #expect(InboxLogic.linkContext(state, s) == FileLinkContext(projectId: "p9"))
        #expect(InboxLogic.dispatchedTicket(state, s)?.id == "t4")
        #expect(InboxLogic.linkContext(state, Self.session(triage: .declined, outcome: "Not for us")) == FileLinkContext())
    }

    // MARK: Agents

    @Test("one list, running or not, latest update first")
    func list() {
        var a = Self.agent("a", .succeeded, endedAt: 5)
        a.updatedAt = 5
        var b = Self.agent("b", .running)
        b.updatedAt = 9
        var c = Self.agent("c", .failed, endedAt: 7)
        c.updatedAt = 7
        #expect(AgentsLogic.list([a, b, c]).map(\.id) == ["b", "c", "a"])
        #expect(AgentsLogic.list([]).isEmpty)
    }

    @Test("the preview is the result once finished, else the prompt (a task's command, unless it's the title)")
    func preview() {
        #expect(AgentsLogic.preview(Self.agent("a", .running, result: "early")) == "Look around")
        #expect(AgentsLogic.preview(Self.agent("a", .succeeded, result: "Found it")) == "Found it")
        #expect(AgentsLogic.preview(Self.agent("a", .failed, result: "")) == "Look around")
        #expect(AgentsLogic.preview(Self.agent("a", .stopped)) == "Look around")
        var task = Self.agent("t", .running, prompt: "", description: "Run the tests")
        task.kind = .bash
        task.command = .value(" bun test ")
        #expect(AgentsLogic.preview(task) == "bun test")
        task.description = ""
        #expect(AgentsLogic.preview(task) == "", "the command is already the title")
        task.status = .succeeded
        task.result = "exit 0"
        #expect(AgentsLogic.preview(task) == "exit 0")
    }

    static func output(_ text: String, end: Int = 0, done: Bool = false, available: Bool = true) -> TaskOutputState {
        TaskOutputState(text: text, end: end, size: end, done: done, available: available, truncated: false)
    }

    @Test("the output pane's note: waiting while it runs, none once it's done, unavailable over both")
    func outputNote() {
        #expect(AgentsLogic.outputNote(nil, running: true) == nil)
        #expect(AgentsLogic.outputNote(Self.output(""), running: true) == "Waiting for output…")
        #expect(AgentsLogic.outputNote(Self.output("", done: true), running: true) == "No output")
        #expect(AgentsLogic.outputNote(Self.output(""), running: false) == "No output")
        #expect(AgentsLogic.outputNote(Self.output("line 1\n"), running: true) == nil)
        #expect(AgentsLogic.outputNote(Self.output("", available: false), running: true) == "Output isn't available")
    }

    @Test("polling reads the tail first, then on from the end while the task runs")
    func polling() {
        #expect(AgentsLogic.pollOffset(nil) == nil)
        #expect(AgentsLogic.pollOffset(Self.output("abc", end: 40)) == 40)
        #expect(AgentsLogic.pollOffset(Self.output("", end: 40, available: false)) == nil)
        #expect(AgentsLogic.keepsPolling(.running, nil))
        #expect(AgentsLogic.keepsPolling(.running, Self.output("a")))
        #expect(!AgentsLogic.keepsPolling(.running, Self.output("a", done: true)))
        #expect(!AgentsLogic.keepsPolling(.succeeded, Self.output("a")))
        #expect(!AgentsLogic.keepsPolling(nil, nil))
    }

    @Test("row label, marks and ticks")
    func marks() {
        #expect(AgentsLogic.rowLabel(Self.agent("a", .succeeded, description: " ")) == "Sub-agent, Done")
        #expect(AgentsLogic.mark(.succeeded) == (.green, "check"))
        #expect(AgentsLogic.mark(.failed) == (.red, "x"))
        #expect(AgentsLogic.mark(.stopped) == (.neutral, "stop"))
        #expect(AgentsLogic.tickSeconds(running: true) == 1)
        #expect(AgentsLogic.tickSeconds(running: false) == 60)
    }
}
