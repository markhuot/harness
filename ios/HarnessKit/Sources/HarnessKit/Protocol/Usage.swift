import Foundation

// The context gauge and plan usage (DESIGN.md "Context gauge", "Plan usage").

/// One ticket's resumable conversation, as of the last model call recorded for it: the last call's
/// input split into what it read from the prompt cache and what it sent fresh (uncached input or
/// written to the cache). The total is `input + cacheRead + cacheWrite`.
public struct ContextUsage: Codable, Sendable, Equatable {
    /// Uncached input tokens of the last call
    public var input: Int
    /// Tokens the last call read from the prompt cache
    public var cacheRead: Int
    /// Tokens the last call wrote to the prompt cache
    public var cacheWrite: Int
    public var output: Int
    /// The session's first call's total input: the fixed prefix every run starts with
    public var prefix: Int
    /// When the last call was recorded (ms)
    public var at: Timestamp
    /// An estimate from the conversation's word count (a driver that reports no tokens): no cached/fresh split
    public var estimated: Bool
    /// Cache misses in the session: calls that re-wrote the conversation into an expired cache
    public var misses: Int
    /// Tokens those misses wrote
    public var missTokens: Int

    public init(input: Int, cacheRead: Int, cacheWrite: Int, output: Int = 0, prefix: Int, at: Timestamp, estimated: Bool = false, misses: Int = 0, missTokens: Int = 0) {
        self.input = input
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.output = output
        self.prefix = prefix
        self.at = at
        self.estimated = estimated
        self.misses = misses
        self.missTokens = missTokens
    }

    /// The context size: the last call's whole input.
    public var total: Int { input + cacheRead + cacheWrite }
}

/// `DEFAULT_CONTEXT_GAUGE_LIMIT` and its bounds (tokens): Settings.contextGaugeLimit.
public enum ContextGaugeLimits {
    public static let `default` = 250_000
    public static let min = 10_000
    public static let max = 2_000_000
}

/// What a driver can do with a ticket's saved session (DriverInfo.sessionActions).
public struct SessionActions: Codable, Sendable, Equatable {
    public var compact: Bool
    public var newSession: Bool
    public init(compact: Bool, newSession: Bool) {
        self.compact = compact
        self.newSession = newSession
    }
}

public enum PlanWindowId: OpenEnum {
    case fiveHour, sevenDay, sevenDayOpus, sevenDaySonnet, monthly
    case unknown(String)
    public static let allKnown: [Self] = [.fiveHour, .sevenDay, .sevenDayOpus, .sevenDaySonnet, .monthly]
    public var rawValue: String {
        switch self {
        case .fiveHour: "five_hour"
        case .sevenDay: "seven_day"
        case .sevenDayOpus: "seven_day_opus"
        case .sevenDaySonnet: "seven_day_sonnet"
        case .monthly: "monthly"
        case let .unknown(r): r
        }
    }
}

/// One usage window of a driver's plan: Claude's 5-hour or weekly limit, Copilot's monthly quota.
public struct PlanWindow: Codable, Sendable, Equatable, Identifiable {
    public var id: PlanWindowId
    public var label: String
    /// 0–100 (may pass 100 only for a quota that allows overage)
    public var usedPercent: Double
    /// When the window resets (ms)
    public var resetsAt: Timestamp
    /// The window's length (s), so clients compute how far through it we are:
    /// 1 − (resetsAt − now) ÷ windowSeconds
    public var windowSeconds: Double

    public init(id: PlanWindowId, label: String, usedPercent: Double, resetsAt: Timestamp, windowSeconds: Double) {
        self.id = id
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.windowSeconds = windowSeconds
    }
}

public enum PlanUsageStatus: OpenEnum {
    case ok, nearLimit, limited
    case unknown(String)
    public static let allKnown: [Self] = [.ok, .nearLimit, .limited]
    public var rawValue: String {
        switch self {
        case .ok: "ok"
        case .nearLimit: "near_limit"
        case .limited: "limited"
        case let .unknown(r): r
        }
    }
}

public struct DriverPlanUsage: Codable, Sendable, Equatable, Identifiable {
    public var driver: String
    public var name: String
    public var windows: [PlanWindow]
    /// From the CLI's rate-limit report when the percentages can't be read: how close the account is
    @Nullable public var status: PlanUsageStatus?
    /// Set when the percentages couldn't be read ("Sign in to Claude Code to see plan usage")
    @Nullable public var error: String?
    /// When it was fetched (ms)
    public var fetchedAt: Timestamp

    public var id: String { driver }

    public init(driver: String, name: String, windows: [PlanWindow], status: PlanUsageStatus? = nil, error: String? = nil, fetchedAt: Timestamp) {
        self.driver = driver
        self.name = name
        self.windows = windows
        self.status = status
        self.error = error
        self.fetchedAt = fetchedAt
    }
}

/// GET /usage and the usage.updated event: one entry per driver that reports plan usage.
public struct PlanUsageReport: Codable, Sendable, Equatable {
    public var drivers: [DriverPlanUsage]
    public init(drivers: [DriverPlanUsage]) { self.drivers = drivers }
}
