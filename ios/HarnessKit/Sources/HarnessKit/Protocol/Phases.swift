import Foundation

// protocol.ts `PHASES`, `Phase`, `PhaseChoice`, `PhaseModels` and `PhaseModelsPatch`: the driver
// and model chosen per run phase (DESIGN.md "Model selection"). Conductor and chat runs use the
// work choice; triage runs follow their watcher.

/// The run phases a driver + model is chosen for, in `PHASES` order.
public enum Phase: String, Codable, Sendable, CaseIterable, Hashable {
    case plan, work, review, complete

    /// `PHASE_LABELS`: the column heading and summary prefix.
    public var label: String {
        switch self {
        case .plan: "Planning"
        case .work: "Work"
        case .review: "Review"
        case .complete: "Complete"
        }
    }
}

/// A phase's driver and model. model nil → the driver's own default model.
public struct PhaseChoice: Codable, Sendable, Equatable, Hashable {
    public var driver: String
    @Nullable public var model: String?

    public init(driver: String, model: String?) {
        self.driver = driver
        self.model = model
    }
}

/// One level's choices (settings, project or ticket): `Partial<Record<Phase, PhaseChoice>>`. A
/// missing phase inherits from the next level up.
public struct PhaseModels: Codable, Sendable, Equatable, Hashable {
    public var plan: PhaseChoice?
    public var work: PhaseChoice?
    public var review: PhaseChoice?
    public var complete: PhaseChoice?

    public init(plan: PhaseChoice? = nil, work: PhaseChoice? = nil, review: PhaseChoice? = nil, complete: PhaseChoice? = nil) {
        self.plan = plan
        self.work = work
        self.review = review
        self.complete = complete
    }

    public subscript(_ phase: Phase) -> PhaseChoice? {
        get {
            switch phase {
            case .plan: plan
            case .work: work
            case .review: review
            case .complete: complete
            }
        }
        set {
            switch phase {
            case .plan: plan = newValue
            case .work: work = newValue
            case .review: review = newValue
            case .complete: complete = newValue
            }
        }
    }

    /// No phase chosen at this level.
    public var isEmpty: Bool { Phase.allCases.allSatisfy { self[$0] == nil } }
}

/// A PATCH of PhaseModels: merged per phase; `.null` clears a phase (it inherits again) and
/// `.absent` leaves it alone.
public struct PhaseModelsPatch: Codable, Sendable, Equatable, Hashable {
    public var plan: Patch<PhaseChoice>
    public var work: Patch<PhaseChoice>
    public var review: Patch<PhaseChoice>
    public var complete: Patch<PhaseChoice>

    public init(plan: Patch<PhaseChoice> = .absent, work: Patch<PhaseChoice> = .absent, review: Patch<PhaseChoice> = .absent, complete: Patch<PhaseChoice> = .absent) {
        self.plan = plan
        self.work = work
        self.review = review
        self.complete = complete
    }

    /// Every phase `models` chooses, set (`{ ...models }`); the rest left out.
    public init(_ models: PhaseModels) {
        self.init()
        for p in Phase.allCases { if let c = models[p] { self[p] = .value(c) } }
    }

    public subscript(_ phase: Phase) -> Patch<PhaseChoice> {
        get {
            switch phase {
            case .plan: plan
            case .work: work
            case .review: review
            case .complete: complete
            }
        }
        set {
            switch phase {
            case .plan: plan = newValue
            case .work: work = newValue
            case .review: review = newValue
            case .complete: complete = newValue
            }
        }
    }

    /// No phase sent.
    public var isEmpty: Bool { Phase.allCases.allSatisfy { !self[$0].isPresent } }
}

/// A value for every phase: `Record<Phase, T>` (a resolved set of choices, a column's selected row).
public struct PerPhase<T> {
    public var plan: T
    public var work: T
    public var review: T
    public var complete: T

    public init(plan: T, work: T, review: T, complete: T) {
        self.plan = plan
        self.work = work
        self.review = review
        self.complete = complete
    }

    /// `Object.fromEntries(PHASES.map((p) => [p, make(p)]))`.
    public init(_ make: (Phase) throws -> T) rethrows {
        self.init(plan: try make(.plan), work: try make(.work), review: try make(.review), complete: try make(.complete))
    }

    public subscript(_ phase: Phase) -> T {
        get {
            switch phase {
            case .plan: plan
            case .work: work
            case .review: review
            case .complete: complete
            }
        }
        set {
            switch phase {
            case .plan: plan = newValue
            case .work: work = newValue
            case .review: review = newValue
            case .complete: complete = newValue
            }
        }
    }
}

extension PerPhase: Sendable where T: Sendable {}
extension PerPhase: Equatable where T: Equatable {}
extension PerPhase: Hashable where T: Hashable {}
extension PerPhase: Codable where T: Codable {}
