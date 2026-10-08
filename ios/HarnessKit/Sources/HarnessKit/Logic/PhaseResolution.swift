import Foundation

// Port of the client-side pieces of shared/src/phases.ts: how a phase resolves across ticket →
// project → settings, what a level inherits, and merging a per-phase patch. The service-only
// legacy conversions (applyLegacySettings and friends) aren't ported.

public enum Phases {
    /// The driver settings use when they don't choose a Work driver.
    public static let fallbackDriver = "claude-code"

    public static func samePhaseChoice(_ a: PhaseChoice?, _ b: PhaseChoice?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return Branches.jsEqual(a.driver, b.driver) && Models.nonEmpty(a.model) == Models.nonEmpty(b.model)
    }

    /// The app's Work driver: its own, else claude-code.
    public static func settingsWorkDriver(_ settings: PhaseModels?) -> String {
        Models.nonEmpty(settings?.work?.driver) ?? fallbackDriver
    }

    /// App settings always resolve: a phase they don't choose uses the Work driver with its default model.
    public static func settingsPhaseChoice(_ settings: PhaseModels?, _ phase: Phase) -> PhaseChoice {
        settings?[phase] ?? PhaseChoice(driver: settingsWorkDriver(settings), model: nil)
    }

    /// A phase's choice, most specific level first: ticket → project → settings.
    public static func resolvePhaseChoice(_ phase: Phase, ticket: PhaseModels? = nil, project: PhaseModels? = nil, settings: PhaseModels?) -> PhaseChoice {
        ticket?[phase] ?? project?[phase] ?? settingsPhaseChoice(settings, phase)
    }

    /// Every phase resolved (see resolvePhaseChoice).
    public static func resolvePhaseModels(ticket: PhaseModels? = nil, project: PhaseModels? = nil, settings: PhaseModels?) -> PerPhase<PhaseChoice> {
        PerPhase { resolvePhaseChoice($0, ticket: ticket, project: project, settings: settings) }
    }

    /// What a level inherits for each phase: the resolution one level up (settings have no level above).
    public static func inheritedPhaseModels(_ level: Models.Level, project: PhaseModels?, settings: PhaseModels?) -> PerPhase<PhaseChoice>? {
        if level == .settings { return nil }
        return resolvePhaseModels(project: level == .ticket ? project : nil, settings: settings)
    }

    /// Merge a per-phase patch over a level's choices; null (or a choice without a driver) clears a phase.
    public static func mergePhaseModels(_ current: PhaseModels?, _ patch: PhaseModelsPatch) -> PhaseModels {
        var out = current ?? PhaseModels()
        for p in Phase.allCases {
            switch patch[p] {
            case .absent: continue
            case let .value(c) where !c.driver.isEmpty: out[p] = PhaseChoice(driver: c.driver, model: Models.nonEmpty(c.model))
            default: out[p] = nil
            }
        }
        return out
    }

    /// Whether a level chooses any phase itself.
    public static func hasPhaseModels(_ pm: PhaseModels?) -> Bool {
        guard let pm else { return false }
        return !pm.isEmpty
    }
}
