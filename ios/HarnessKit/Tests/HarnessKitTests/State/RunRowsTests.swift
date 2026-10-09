import Testing
@testable import HarnessKit

@Suite("RunRows")
struct RunRowsTests {
    static func run(_ over: (inout Run) -> Void = { _ in }) -> Run {
        var r = Run(id: "r", sessionId: "s", kind: .work, status: .succeeded, driver: "claude-code", prompt: "Do it",
                    createdAt: 0, startedAt: 1000, endedAt: 13_400)
        over(&r)
        return r
    }

    static let def = PhaseChoice(driver: "claude-code", model: "opus")

    @Test("durations", arguments: [
        (0.0, "0s"), (42_000, "42s"), (59_500, "1m 0s"), (185_000, "3m 5s"), (3_720_000, "1h 2m"), (-5000, "0s"),
    ])
    func duration(ms: Double, text: String) {
        #expect(Format.duration(ms) == text)
    }

    @Test("token counts", arguments: [
        (850.0, "850"), (999, "999"), (1000, "1k"), (12_345, "12.3k"), (48_250, "48.3k"), (999_949, "999.9k"),
        (999_950, "1M"), (1_234_567, "1.2M"),
    ])
    func tokens(n: Double, text: String) {
        #expect(RunRows.formatTokens(n) == text)
    }

    @Test("costs", arguments: [
        (0.42, "$0.42"), (12.3, "$12.30"), (0.004, "<$0.01"), (0.005, "$0.01"), (0.0, "$0.00"),
    ])
    func cost(usd: Double, text: String) {
        #expect(RunRows.formatCost(usd) == text)
    }

    @Test("the phase default is what the project and Settings give, none for triage or outside a ticket")
    func phaseDefault() {
        let settings = PhaseModels(work: Self.def, review: PhaseChoice(driver: "anthropic-api", model: nil))
        #expect(RunRows.phaseDefault(.work, project: nil, settings: settings) == Self.def)
        #expect(RunRows.phaseDefault(.chat, project: nil, settings: settings) == Self.def)
        #expect(RunRows.phaseDefault(.review, project: nil, settings: settings)?.driver == "anthropic-api")
        let project = PhaseModels(work: PhaseChoice(driver: "dummy", model: nil))
        #expect(RunRows.phaseDefault(.work, project: project, settings: settings)?.driver == "dummy")
        #expect(RunRows.phaseDefault(.triage, project: nil, settings: settings) == nil)
        #expect(RunRows.phaseDefault(.work, hasTicket: false, project: nil, settings: settings) == nil)
    }

    @Test("driver and model show only when they differ from the default")
    func differs() {
        var i = RunRows.info(Self.run { $0.model = "opus" }, phaseDefault: Self.def, now: 20_000)
        #expect(i.driver == nil && i.model == nil)
        i = RunRows.info(Self.run { $0.model = "haiku" }, phaseDefault: Self.def, now: 20_000)
        #expect(i.driver == nil && i.model == "haiku")
        i = RunRows.info(Self.run { $0.driver = "anthropic-api"; $0.model = "opus" }, phaseDefault: Self.def, now: 20_000)
        #expect(i.driver == "anthropic-api" && i.model == "opus")
        i = RunRows.info(Self.run(), phaseDefault: Self.def, now: 20_000)
        #expect(i.model == nil)
        i = RunRows.info(Self.run { $0.model = "opus" }, phaseDefault: nil, now: 20_000)
        #expect(i.driver == "claude-code" && i.model == "opus")
        i = RunRows.info(Self.run(), phaseDefault: PhaseChoice(driver: "claude-code", model: nil), now: 0)
        #expect(i.model == nil)
    }

    @Test("tokens and cost appear only when reported")
    func usage() {
        var i = RunRows.info(Self.run(), phaseDefault: Self.def, now: 20_000)
        #expect(i.tokens == nil && i.tokensDetail == nil && i.cost == nil)
        i = RunRows.info(Self.run { $0.inputTokens = 40_000; $0.outputTokens = 8200; $0.costUsd = 0.416 }, phaseDefault: Self.def, now: 20_000)
        #expect(i.tokens == "48.2k tokens" && i.tokensDetail == "40k in · 8.2k out" && i.cost == "$0.42")
        #expect(RunRows.info(Self.run { $0.inputTokens = 500 }, phaseDefault: Self.def, now: 0).tokens == "500 tokens")
        #expect(RunRows.info(Self.run { $0.costUsd = 0 }, phaseDefault: Self.def, now: 0).cost == "$0.00")
    }

    @Test("elapsed: finished, running, queued and never started")
    func elapsed() {
        #expect(RunRows.info(Self.run(), phaseDefault: Self.def, now: 99_000).elapsed == "12s")
        #expect(RunRows.info(Self.run { $0.endedAt = 1100 }, phaseDefault: Self.def, now: 0).elapsed == "1s")
        let running = RunRows.info(Self.run { $0.status = .running; $0.endedAt = nil }, phaseDefault: Self.def, now: 66_000)
        #expect(running.elapsed == "1m 5s" && running.start == "1m ago")
        let queued = RunRows.info(Self.run { $0.status = .queued; $0.startedAt = nil; $0.endedAt = nil; $0.createdAt = 10_000 }, phaseDefault: Self.def, now: 25_000)
        #expect(queued.elapsed == "waiting 15s" && queued.start == nil)
        let cancelled = RunRows.info(Self.run { $0.status = .cancelled; $0.startedAt = nil; $0.endedAt = 5000; $0.createdAt = 1000 }, phaseDefault: Self.def, now: 400_000)
        #expect(cancelled.elapsed == nil && cancelled.start == "7m ago")
    }
}
