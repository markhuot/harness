import Foundation
import Testing
@testable import HarnessKit

/// One scenario from shared/fixtures/board.ts: actions replayed through the reducer, with probe
/// outputs (and, where recorded, the whole state) after each step.
struct BoardScenario: Decodable, Sendable, CustomTestStringConvertible {
    struct Probe: Decodable, Sendable {
        let fn: String
        let args: [JSONValue]
        let output: JSONValue
    }

    struct Step: Decodable, Sendable {
        let actions: [BoardAction]
        let patch: JSONValue?
        let probes: [Probe]
        let state: JSONValue?
    }

    let name: String
    let initial: BoardState?
    let steps: [Step]
    var testDescription: String { name }

    static func load(_ module: String, _ export: String) -> [BoardScenario] {
        do {
            let list = try Fixture.value(module, export, as: [BoardScenario].self)
            precondition(!list.isEmpty, "Fixture \(module).\(export) has no scenarios")
            return list
        } catch {
            fatalError("Fixture \(module).\(export): \(error)")
        }
    }
}

enum BoardProbe {
    struct UnknownProbe: Error, CustomStringConvertible {
        let fn: String
        var description: String { "No Swift probe named \(fn)" }
    }

    /// Every probe this runner knows; checked against PROBE_NAMES in board.ts.
    static let names = [
        "boardColumns", "canLoadMoreDone", "canLoadMoreSearch", "childrenOf", "composerCandidates", "composerProject", "conductorsNeedingChildren",
        "defaultDriverOf", "defaultModelOf", "dependencyStates", "dependentsOf", "doneColumn", "doneCount", "hasCustomDriver", "hasCustomModel", "latestActivity",
        "liveDelta", "matchesQuery", "needsFirstDonePage", "searchColumns", "searchStatusText", "sortedProjects", "specBody", "specRevisions",
        "subagentById", "subagentPath", "subagentTranscript", "subagentsOf", "taskOutputOf", "ticketByKey", "ticketLinkable",
        "ticketsForProject", "transcript", "triageSessions", "unresolvedKeys",
    ].sorted()

    static func decode<T: Decodable>(_ value: JSONValue, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }

    static func ids(_ ts: [Ticket]) -> JSONValue { .array(ts.map { .string($0.id) }) }
    static func strings(_ xs: [String]) -> JSONValue { .array(xs.map(JSONValue.string)) }
    static func id(_ t: Ticket?) -> JSONValue { t.map { .string($0.id) } ?? .null }
    static func columns(_ c: Columns) -> JSONValue {
        .object(["planning": ids(c.planning), "in_progress": ids(c.inProgress), "blocked": ids(c.blocked), "review": ids(c.review), "done": ids(c.done)])
    }
    static func opt(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }

    /// Runs a probe the way board.ts's PROBES does, with the same projection (tickets → ids).
    static func run(_ s: BoardState, _ fn: String, _ args: [JSONValue]) throws -> JSONValue {
        func arg<T: Decodable>(_ i: Int, _ type: T.Type = T.self) throws -> T { try decode(i < args.count ? args[i] : .null, as: T.self) }
        switch fn {
        case "boardColumns": return columns(s.boardColumns(try arg(0, String?.self)))
        case "doneColumn": return ids(Paging.doneColumn(s, try arg(0, String?.self)))
        case "doneCount": return .number(Double(Paging.doneCount(s, try arg(0, String?.self), loaded: try arg(1))))
        case "canLoadMoreDone": return .bool(Paging.canLoadMoreDone(s, try arg(0, String?.self)))
        case "needsFirstDonePage": return .bool(Paging.needsFirstDonePage(s, try arg(0, String?.self)))
        case "searchColumns":
            let r = Paging.searchColumns(s, try arg(0, String?.self))
            return .object(["columns": columns(r.columns), "pending": .bool(r.pending)])
        case "searchStatusText": return opt(s.search.map(Paging.searchStatusText))
        case "canLoadMoreSearch": return .bool(Paging.canLoadMoreSearch(s.search))
        case "ticketByKey": return id(s.ticketByKey(try arg(0)))
        case "ticketLinkable": return .bool(s.ticketLinkable(try arg(0)))
        case "dependencyStates":
            let t = s.tickets[try arg(0, String.self)]!
            return .array(s.dependencyStates(t).map { d in
                .object(["key": .string(d.key), "done": .bool(d.done), "state": .string(d.state.rawValue), "ticket": id(d.ticket), "missing": d.missing.map(JSONValue.bool) ?? .null])
            })
        case "unresolvedKeys": return strings(s.unresolvedKeys(args.isEmpty ? [] : try arg(0)))
        case "conductorsNeedingChildren": return ids(s.conductorsNeedingChildren())
        case "dependentsOf":
            let t = s.tickets[try arg(0, String.self)]!
            return .array(s.dependentsOf(t).map { .object(["key": .string($0.key), "ticket": id($0.ticket)]) })
        case "liveDelta": return .array(s.liveDelta(try arg(0)).map { .object(["runId": .string($0.runId), "text": .string($0.text)]) })
        case "latestActivity": return opt(s.latestActivity(try arg(0), kinds: args.count > 1 ? try arg(1, [ActivityKind].self) : nil)?.id)
        case "specBody": return opt(s.specBody(try arg(0), rev: try arg(1)))
        case "specRevisions":
            guard let list = s.specRevisions[try arg(0, String.self)] else { return .null }
            return .array(list.map { .object(["rev": .number(Double($0.rev)), "approvedBaseline": .bool($0.approvedBaseline)]) })
        case "triageSessions": return strings(s.triageSessions().map(\.id))
        case "defaultDriverOf": return opt(s.defaultDriverOf(try arg(0)))
        case "hasCustomDriver": return .bool(s.hasCustomDriver(try arg(0, Ticket.self)))
        case "defaultModelOf": return opt(s.defaultModelOf(try arg(0), driver: try arg(1)))
        case "hasCustomModel": return .bool(s.hasCustomModel(try arg(0, Ticket.self), models: args.count > 1 ? try arg(1, [ModelInfo]?.self) : nil))
        case "childrenOf": return ids(s.childrenOf(try arg(0)))
        case "ticketsForProject": return ids(s.ticketsForProject(try arg(0, String?.self)))
        case "sortedProjects": return strings(s.sortedProjects().map(\.id))
        case "composerProject": return .string(s.composerProject(try arg(0), candidates: try arg(1)))
        case "composerCandidates": return .array(s.composerCandidates(try arg(0, String?.self), last: try arg(1, String?.self)).map(opt))
        case "matchesQuery": return .bool(Paging.matchesQuery(s.tickets[try arg(0, String.self)]!, try arg(1), aliases: s.keyAliases))
        case "subagentsOf": return s.subagentsOf(try arg(0)).map { strings($0.map(\.id)) } ?? .null
        case "subagentById": return opt(s.subagentById(try arg(0), try arg(1))?.status.rawValue)
        case "subagentPath": return strings(s.subagentPath(try arg(0), try arg(1)).map(\.id))
        case "subagentTranscript":
            guard let t = s.subagentTranscript(try arg(0), try arg(1)) else { return .null }
            return .object(["seqs": .array(t.entries.map { .number(Double($0.seq)) }), "loaded": .bool(t.loaded)])
        case "taskOutputOf":
            guard let o = s.taskOutputOf(try arg(0), try arg(1)) else { return .null }
            return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(o))
        case "transcript":
            guard let t = s.transcripts[try arg(0, String.self)] else { return .null }
            return .object(["ids": strings(t.entries.map(\.id)), "loaded": .bool(t.loaded)])
        default:
            throw UnknownProbe(fn: fn)
        }
    }

    /// Replay a scenario, checking each probe and recorded state.
    static func check(_ scenario: BoardScenario) throws {
        var state = scenario.initial ?? .initial
        for (i, step) in scenario.steps.enumerated() {
            if case let .object(patch)? = step.patch {
                guard case var .object(current) = try encodeState(state) else { return }
                for (k, v) in patch { current[k] = v }
                state = try decode(.object(current), as: BoardState.self)
            }
            for action in step.actions { state.reduce(action) }
            for probe in step.probes {
                let got = try run(state, probe.fn, probe.args)
                let same = try jsonEqual(JSONEncoder().encode(got), JSONEncoder().encode(probe.output))
                #expect(same, "step \(i) \(probe.fn)(\(probe.args)): got \(got), want \(probe.output)")
            }
            if let want = step.state {
                let same = try jsonEqual(JSONEncoder().encode(state), JSONEncoder().encode(want))
                let detail = same ? "" : try diff(state, want)
                #expect(same, "step \(i): state differs\n\(detail)")
            }
        }
    }

    static func encodeState(_ s: BoardState) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(s))
    }

    /// Top-level fields whose JSON differs, for a readable failure.
    static func diff(_ s: BoardState, _ want: JSONValue) throws -> String {
        guard case let .object(got) = try encodeState(s), case let .object(exp) = want else { return "" }
        var out: [String] = []
        for k in Set(got.keys).union(exp.keys).sorted() {
            let a = try JSONEncoder().encode(got[k] ?? .null), b = try JSONEncoder().encode(exp[k] ?? .null)
            if try !jsonEqual(a, b) { out.append("\(k):\n  got  \(String(decoding: a, as: UTF8.self).prefix(800))\n  want \(String(decoding: b, as: UTF8.self).prefix(800))") }
        }
        return out.joined(separator: "\n")
    }
}

@Suite("state/reducer.ts parity")
struct ReducerScenarioTests {
    @Test(arguments: BoardScenario.load("stateReducer", "scenarios"))
    func scenario(_ s: BoardScenario) throws { try BoardProbe.check(s) }

    @Test func everyProbeIsImplemented() throws {
        let names = try Fixture.value("stateReducer", "probeNames", as: [String].self)
        #expect(names == BoardProbe.names)
    }

    struct ReadyInput: Decodable, Sendable {
        let agentReview: ReviewState
        let humanReview: ReviewState
        let status: TicketStatus
    }

    @Test(arguments: Fixture.cases("stateReducer", "isReadyCases", input: ReadyInput.self, output: Bool.self))
    func isReady(_ c: Fixture.Case<ReadyInput, Bool>) {
        let t = Ticket(id: "t", key: "T", projectId: "p1", title: "t", spec: "", status: c.input.status, sessionId: "s", driver: "dummy",
                       agentReview: c.input.agentReview, humanReview: c.input.humanReview, createdAt: 0, updatedAt: 0)
        #expect(BoardState.isReady(t) == c.output)
    }

    struct DropInput: Decodable, Sendable {
        let column: [Double]
        let index: Int
    }

    @Test(arguments: Fixture.cases("stateReducer", "positionForDropCases", input: DropInput.self, output: Double.self))
    func positionForDrop(_ c: Fixture.Case<DropInput, Double>) {
        #expect(BoardState.positionForDrop(c.input.column, index: c.input.index) == c.output)
    }

    struct Item: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let n: Double
    }

    struct MergeInput: Decodable, Sendable {
        let existing: [Item]
        let incoming: [Item]
    }

    @Test(arguments: Fixture.cases("stateReducer", "mergeByIdCases", input: MergeInput.self, output: [Item].self))
    func mergeById(_ c: Fixture.Case<MergeInput, [Item]>) {
        #expect(BoardState.mergeById(c.input.existing, c.input.incoming, order: \.n) == c.output)
    }

    struct KeyInput: Decodable, Sendable {
        let sessionId: String
        let subagentId: String?
    }

    @Test(arguments: Fixture.cases("stateReducer", "transcriptKeyCases", input: KeyInput.self, output: String.self))
    func transcriptKey(_ c: Fixture.Case<KeyInput, String>) {
        #expect(BoardState.transcriptKey(c.input.sessionId, c.input.subagentId) == c.output)
    }

    @Test func boardActionsRoundTrip() throws {
        // Every action in every scenario re-encodes to the JSON it was decoded from.
        let raw = try Fixture.value("stateReducer", "scenarios", as: [JSONValue].self)
            + Fixture.value("statePaging", "doneScenarios", as: [JSONValue].self)
            + Fixture.value("statePaging", "searchScenarios", as: [JSONValue].self)
            + Fixture.value("statePaging", "groupScenarios", as: [JSONValue].self)
        var count = 0
        for scenario in raw {
            guard case let .array(steps)? = scenario["steps"] else { continue }
            for step in steps {
                guard case let .array(actions)? = step["actions"] else { continue }
                for a in actions {
                    let action = try BoardProbe.decode(a, as: BoardAction.self)
                    let back = try JSONEncoder().encode(action)
                    let ok = try jsonEqual(back, JSONEncoder().encode(a))
                    #expect(ok, "\(action.type) didn't round-trip")
                    count += 1
                }
            }
        }
        #expect(count > 100)
    }
}

@Suite("state/paging.ts parity")
struct PagingScenarioTests {
    @Test(arguments: BoardScenario.load("statePaging", "doneScenarios"))
    func done(_ s: BoardScenario) throws { try BoardProbe.check(s) }

    @Test(arguments: BoardScenario.load("statePaging", "searchScenarios"))
    func search(_ s: BoardScenario) throws { try BoardProbe.check(s) }

    @Test(arguments: BoardScenario.load("statePaging", "groupScenarios"))
    func groups(_ s: BoardScenario) throws { try BoardProbe.check(s) }

    @Test(arguments: BoardScenario.load("statePaging", "unloadedScenarios"))
    func unloaded(_ s: BoardScenario) throws { try BoardProbe.check(s) }

    struct MatchInput: Decodable, Sendable {
        let ticket: Ticket
        let q: String
        let aliases: [String: String]?
    }

    @Test(arguments: Fixture.cases("statePaging", "matchesQueryCases", input: MatchInput.self, output: Bool.self))
    func matchesQuery(_ c: Fixture.Case<MatchInput, Bool>) {
        #expect(Paging.matchesQuery(c.input.ticket, c.input.q, aliases: c.input.aliases ?? [:]) == c.output)
    }

    @Test(arguments: Fixture.cases("statePaging", "searchStatusTextCases", input: SearchState.self, output: String.self))
    func searchStatusText(_ c: Fixture.Case<SearchState, String>) {
        #expect(Paging.searchStatusText(c.input) == c.output)
    }
}

@Suite("state/subagents.ts parity")
struct SubagentScenarioTests {
    @Test(arguments: BoardScenario.load("stateSubagents", "scenarios"))
    func scenario(_ s: BoardScenario) throws { try BoardProbe.check(s) }

    @Test func statusLabels() throws {
        let labels = try Fixture.value("stateSubagents", "statusLabel", as: [String: String].self)
        for status in SubagentStatus.allKnown { #expect(Subagents.statusLabel(status) == labels[status.rawValue]) }
        #expect(labels.count == SubagentStatus.allKnown.count)
        #expect(Subagents.statusLabel(.unknown("paused")) == "paused")
    }

    @Test func taskConstants() throws {
        let kinds = try Fixture.value("stateSubagents", "taskKindLabel", as: [String: String].self)
        #expect(Dictionary(uniqueKeysWithValues: Subagents.taskKindLabel.map { ($0.key.rawValue, $0.value) }) == kinds)
        #expect(try Fixture.value("stateSubagents", "taskOutputKeepChars", as: Int.self) == BoardState.taskOutputKeepChars)
        #expect(try Fixture.value("stateSubagents", "taskOutputPollMs", as: Double.self) == Subagents.taskOutputPollMs)
    }

    static func fold(_ outs: [TaskOutput]) -> TaskOutputState? {
        var s = BoardState.initial
        for o in outs { s.reduce(.taskOutput(sessionId: "s1", subagentId: "c1", output: o)) }
        return s.taskOutputOf("s1", "c1")
    }

    static func slice(_ text: String, _ start: Int = 0) -> TaskOutput {
        let end = start + text.utf8.count
        return TaskOutput(text: text, start: start, end: end, size: end, done: false, available: true)
    }

    @Test("past the keep limit, the oldest lines are dropped at a line break, counting UTF-16 code units")
    func keepLimit() throws {
        let keep = BoardState.taskOutputKeepChars
        // 100 UTF-16 units a line, but 99 Characters: counting Characters would keep too much.
        let line = "😀" + String(repeating: "x", count: 97) + "\n"
        let big = String(repeating: line, count: keep / 100 + 5)
        let t = try #require(Self.fold([Self.slice(big)]))
        #expect(t.truncated)
        #expect(t.text.utf16.count <= keep)
        #expect(t.text.utf16.count % 100 == 0)
        #expect(t.text.hasPrefix("😀"))
        #expect(t.end == big.utf8.count)
    }

    @Test("with no line break near the cut, it cuts mid-line at exactly the limit")
    func keepLimitMidLine() throws {
        let keep = BoardState.taskOutputKeepChars
        let t = try #require(Self.fold([Self.slice("a\n"), Self.slice(String(repeating: "y", count: keep + 10), 2)]))
        #expect(t.text.utf16.count == keep)
        #expect(t.text.allSatisfy { $0 == "y" })
        #expect(t.truncated)
    }

    struct LabelInput: Decodable, Sendable {
        let description: String
        let agentType: String?
        let kind: SubagentKind?
        let command: String?
    }

    @Test(arguments: Fixture.cases("stateSubagents", "titleCases", input: LabelInput.self, output: String.self))
    func title(_ c: Fixture.Case<LabelInput, String>) {
        #expect(Subagents.title(description: c.input.description, agentType: c.input.agentType, kind: c.input.kind, command: c.input.command) == c.output)
    }

    @Test(arguments: Fixture.cases("stateSubagents", "typeLabelCases", input: LabelInput.self, output: String?.self))
    func typeLabel(_ c: Fixture.Case<LabelInput, String?>) {
        #expect(Subagents.typeLabel(description: c.input.description, agentType: c.input.agentType, kind: c.input.kind) == c.output)
    }

    struct KindInput: Decodable, Sendable { let kind: SubagentKind? }

    @Test(arguments: Fixture.cases("stateSubagents", "openLabelCases", input: KindInput.self, output: String.self))
    func openLabel(_ c: Fixture.Case<KindInput, String>) {
        #expect(Subagents.openLabel(c.input.kind) == c.output)
    }

    struct DurationInput: Decodable, Sendable {
        let startedAt: Double
        let endedAt: Double?
        let now: Double?
    }

    @Test(arguments: Fixture.cases("stateSubagents", "durationCases", input: DurationInput.self, output: String.self))
    func duration(_ c: Fixture.Case<DurationInput, String>) {
        #expect(Subagents.duration(startedAt: c.input.startedAt, endedAt: c.input.endedAt, now: c.input.now ?? 0) == c.output)
    }

    @Test(arguments: Fixture.cases("stateSubagents", "sortCases", input: [Subagent].self, output: [Subagent].self))
    func sort(_ c: Fixture.Case<[Subagent], [Subagent]>) {
        #expect(Subagents.sort(c.input).map(\.id) == c.output.map(\.id))
    }
}
