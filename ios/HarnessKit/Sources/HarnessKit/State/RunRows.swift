import Foundation

// Port of shared/src/state/runs.ts: how one run's row reads in the ticket's Runs list (DESIGN.md
// "What a run records"). Pure. Counts and cents use integer maths, as in TS, so both clients
// print the same text.

public enum RunRows {
    /// 42s, 3m 5s, 1h 2m: a span in milliseconds, rounded to the second.
    public static func formatDuration(_ ms: Double) -> String {
        let total = Int(max(0, JSCompat.round(ms / 1000)))
        if total < 60 { return "\(total)s" }
        let m = total / 60
        if m < 60 { return "\(m)m \(total % 60)s" }
        return "\(m / 60)h \(m % 60)m"
    }

    /// 850, 12.3k, 1.2M (one decimal, dropped when it's .0).
    public static func formatTokens(_ n: Double) -> String {
        let count = Int(max(0, JSCompat.round(n)))
        if count < 1000 { return "\(count)" }
        let kTenths = Int(JSCompat.round(Double(count) / 100))
        if kTenths < 10000 { return "\(tenths(kTenths))k" }
        return "\(tenths(Int(JSCompat.round(Double(count) / 100_000))))M"
    }

    private static func tenths(_ t: Int) -> String {
        t % 10 == 0 ? "\(t / 10)" : "\(t / 10).\(t % 10)"
    }

    /// $0.42, $12.30, or <$0.01 for a cost under a cent that isn't zero.
    public static func formatCost(_ usd: Double) -> String {
        let cents = Int(JSCompat.round(max(0, usd) * 100))
        if cents == 0 && usd > 0 { return "<$0.01" }
        let rest = cents % 100
        return "$\(cents / 100).\(rest < 10 ? "0" : "")\(rest)"
    }

    /// The phase a run kind's driver and model come from (nil: triage, which follows its watcher).
    public static func runPhase(_ kind: RunKind) -> Phase? {
        switch kind {
        case .plan: .plan
        case .review: .review
        case .complete: .complete
        case .triage: nil
        default: .work // work, conductor, chat
        }
    }

    /// What a ticket's run of this kind uses unless something else was chosen for it: the choice
    /// its phase inherits from the project and Settings (so a ticket-level override shows on its
    /// runs). nil for triage and for a run outside a ticket.
    public static func phaseDefault(_ kind: RunKind, hasTicket: Bool = true, project: PhaseModels?, settings: PhaseModels?) -> PhaseChoice? {
        guard hasTicket, let phase = runPhase(kind) else { return nil }
        return Phases.inheritedPhaseModels(.ticket, project: project, settings: settings)?[phase]
    }

    public struct Info: Equatable, Sendable {
        /// When it started ("5m ago"); nil while it still waits in the queue.
        public var start: String?
        /// How long it ran, so far while running; "waiting 12s" while queued; nil when it never started.
        public var elapsed: String?
        /// "48.2k tokens"; nil when the driver reported none.
        public var tokens: String?
        /// The input/output split behind `tokens`.
        public var tokensDetail: String?
        /// "$0.42"; nil when the driver reported no cost.
        public var cost: String?
        /// The driver id, only when it isn't the phase default (or there is none).
        public var driver: String?
        /// The model, only when it isn't the phase default (or there is none) and the run recorded one.
        public var model: String?
    }

    public static func info(_ run: Run, phaseDefault: PhaseChoice?, now: Double) -> Info {
        let queued = run.status == .queued
        let running = run.status == .running
        let started = run.startedAt.flatMap { $0 == 0 ? nil : $0 }
        let ended = run.endedAt.flatMap { $0 == 0 ? nil : $0 }
        var elapsed: String?
        if queued {
            elapsed = "waiting \(formatDuration(now - run.createdAt))"
        } else if let started, ended != nil || running {
            elapsed = formatDuration(max(1000, (ended ?? now) - started))
        }

        let hasTokens = run.inputTokens != nil || run.outputTokens != nil
        let input = run.inputTokens ?? 0
        let output = run.outputTokens ?? 0

        let sameDriver = phaseDefault.map { Branches.jsEqual($0.driver, run.driver) } ?? false
        let model = Models.nonEmpty(run.model)
        let showModel = model != nil && !(sameDriver && model == Models.nonEmpty(phaseDefault?.model))
        return Info(
            start: queued ? nil : Format.relativeTime(started ?? run.createdAt, now: now),
            elapsed: elapsed,
            tokens: hasTokens ? "\(formatTokens(input + output)) tokens" : nil,
            tokensDetail: hasTokens ? "\(formatTokens(input)) in · \(formatTokens(output)) out" : nil,
            cost: run.costUsd.map(formatCost),
            driver: sameDriver ? nil : run.driver,
            model: showModel ? model : nil
        )
    }
}
