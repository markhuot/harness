import Foundation

/// The ticket header's context gauge: how full the ticket's resumable conversation is against the
/// limit (Settings.contextGaugeLimit), split into cached and fresh tokens, with the cache-miss count
/// and the menu actions its driver offers (DESIGN.md "Context gauge").
public struct ContextGauge: Equatable, Sendable {
    /// nil: a fresh session (no resumable conversation yet).
    public let usage: ContextUsage?
    public let limit: Int

    public init(usage: ContextUsage?, limit: Int) {
        self.usage = usage
        self.limit = max(1, limit)
    }

    public init(ticket: Ticket, limit: Int) {
        self.init(usage: ticket.context.optional, limit: limit)
    }

    /// Whether the gauge shows at all: only for a driver that reports context usage.
    public static func isShown(driver: DriverInfo?) -> Bool {
        driver?.reportsContextUsage == true
    }

    // MARK: State

    public var isEmpty: Bool { usage == nil }
    public var isEstimated: Bool { usage?.estimated == true }
    public var total: Int { usage?.total ?? 0 }
    /// Past the limit: the needle clamps at the end and the dial turns red. Exactly at it isn't over.
    public var isOver: Bool { total > limit }

    /// The needle's position, 0…1: the total as a share of the limit, clamped.
    public var fraction: Double { clamp(Double(total) / Double(limit)) }

    /// The slate part of the fill (read from the prompt cache), 0…1 of the dial. An estimate has no split.
    public var cachedFraction: Double {
        guard let usage, !usage.estimated, total > 0 else { return 0 }
        return fraction * Double(usage.cacheRead) / Double(total)
    }

    /// The amber part (sent fresh or written to the cache); an estimate fills as one tone, here.
    public var freshFraction: Double { fraction - cachedFraction }

    /// Where the tick for the session's fixed starting prefix sits, 0…1; nil when there's no prefix
    /// to mark (empty, or a prefix that's no smaller than the total reads as the whole fill).
    public var prefixFraction: Double? {
        guard let usage, usage.prefix > 0 else { return nil }
        return clamp(Double(usage.prefix) / Double(limit))
    }

    private func clamp(_ x: Double) -> Double { min(1, max(0, x)) }

    // MARK: Text

    /// "82k", "950", "1.2M": a token count at header size.
    public static func tokens(_ n: Int) -> String {
        let n = max(0, n)
        if n < 1000 { return String(n) }
        let k = Int((Double(n) / 1000).rounded())
        if k < 1000 { return "\(k)k" }
        let m = (Double(n) / 100_000).rounded() / 10
        return m == m.rounded() ? "\(Int(m))M" : String(format: "%.1fM", m)
    }

    /// The label beside the dial: "82k", "~82k*" for an estimate, "New" for a fresh session.
    public var label: String {
        guard usage != nil else { return "New" }
        return isEstimated ? "~\(Self.tokens(total))*" : Self.tokens(total)
    }

    /// The tooltip and accessibility label.
    public var summary: String {
        guard usage != nil else { return "New session: no context yet" }
        let limitText = Self.tokens(limit)
        let over = isOver ? ", over the limit" : ""
        if let usage, isEstimated {
            return "Context about \(Self.tokens(total)) of \(limitText) (estimated from word count)\(over)"
        }
        let fresh = (usage?.input ?? 0) + (usage?.cacheWrite ?? 0)
        return "Context \(Self.tokens(total)) of \(limitText): \(Self.tokens(usage?.cacheRead ?? 0)) cached, \(Self.tokens(fresh)) fresh\(over)"
    }

    // MARK: Cache misses

    /// The misses that count: an estimate has none.
    public var misses: Int { isEstimated ? 0 : max(0, usage?.misses ?? 0) }

    /// The amber capsule on the gauge's corner: "3 misses"; nil when there are none.
    public var missBadge: String? {
        guard misses > 0 else { return nil }
        return misses == 1 ? "1 miss" : "\(misses) misses"
    }

    /// The menu's top row: "3 cache misses (377k tokens re-written)"; nil when there are none.
    public var missRow: String? {
        guard misses > 0 else { return nil }
        let noun = misses == 1 ? "1 cache miss" : "\(misses) cache misses"
        return "\(noun) (\(Self.tokens(usage?.missTokens ?? 0)) tokens re-written)"
    }

    // MARK: Info popovers

    public static let gaugeInfo = "How much conversation the next run of this ticket re-reads on every model call. Large contexts make each call slower and more expensive, and old context can steer the agent wrong. Slate is read from the prompt cache (cheap); amber was sent fresh or written to the cache (about 20× the price). The tick marks where every run starts: the system prompt, tools and project instructions. Compact or start a new session when it gets large."
    public static let estimatedGaugeInfo = "Estimated from the conversation's word count; Copilot doesn't report tokens."
    public static let missInfo = "A cache miss is a model call that had to write the whole conversation back into the prompt cache because the cache expired, usually after the agent waited more than 5 minutes (a long build or a simulator run). Each miss costs about 20× what reading it would have. Harness counts them so you can see when that's happening: setting `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` in the Claude Code driver's environment variables keeps the cache for an hour."

    public var info: String { isEstimated ? Self.estimatedGaugeInfo : Self.gaugeInfo }

    // MARK: Menu

    /// How a menu action shows.
    public enum Availability: Equatable, Sendable {
        /// The driver can't do it: not in the menu.
        case hidden
        case enabled
        /// Greyed, with the reason beneath.
        case disabled(String)

        public var isShown: Bool { self != .hidden }
        public var isEnabled: Bool { self == .enabled }
    }

    public static let busyReason = "Available when the run ends"
    public static let compactingReason = "Compacting…"

    public struct Menu: Equatable, Sendable {
        public var compact: Availability
        public var newSession: Availability
        /// The menu itself opens: not while the session compacts.
        public var opens: Bool
    }

    /// Which menu items show and work, from the ticket's driver, a run going (`busy`) and a compact
    /// in progress. Limit… is always there; the session actions wait for the run to end.
    public static func menu(driver: DriverInfo?, busy: Bool, compacting: Bool) -> Menu {
        func availability(_ supported: Bool?) -> Availability {
            guard supported == true else { return .hidden }
            if compacting { return .disabled(compactingReason) }
            return busy ? .disabled(busyReason) : .enabled
        }
        let actions = driver?.sessionActions
        return Menu(compact: availability(actions?.compact), newSession: availability(actions?.newSession), opens: !compacting)
    }
}
