import Foundation

// The sidebar's plan-usage gauges (DESIGN.md "Plan usage"): one compact bar per usage window a driver
// reports, in two display modes. Pure logic: the view renders what `PlanUsage.rows` returns.

/// What the bars show, saved per device.
public enum PlanUsageMode: String, CaseIterable, Sendable {
    /// The percentages the plan reports
    case usedSoFar = "used"
    /// Used ÷ how far through the window we are: are the agents on pace to run out before it resets?
    case projected

    public var title: String {
        switch self {
        case .usedSoFar: "Used so far"
        case .projected: "Projected at reset"
        }
    }
}

/// Which drivers' rows show, saved per device (as `storage`, an `@AppStorage` string).
public enum PlanUsageFilter: Equatable, Sendable {
    case all
    case driver(String)
    /// Collapse the section to its one-line header
    case hide

    public init(storage: String) {
        switch storage {
        case "all", "": self = .all
        case "hide": self = .hide
        default:
            if storage.hasPrefix("driver:"), storage.count > "driver:".count {
                self = .driver(String(storage.dropFirst("driver:".count)))
            } else {
                self = .all
            }
        }
    }

    public var storage: String {
        switch self {
        case .all: "all"
        case .hide: "hide"
        case let .driver(d): "driver:\(d)"
        }
    }
}

/// A bar's colour. Green only appears in the projected mode.
public enum PlanUsageBand: Equatable, Sendable {
    case neutral, green, amber, red
}

/// One line of the section.
public enum PlanUsageRow: Equatable, Sendable, Identifiable {
    case gauge(PlanGauge)
    /// The driver's usage can't be read ("Sign in to Claude Code to see plan usage"), or only its state is known
    case note(PlanNote)

    public var id: String {
        switch self {
        case let .gauge(g): g.id
        case let .note(n): n.id
        }
    }
}

public struct PlanGauge: Equatable, Sendable, Identifiable {
    public var id: String
    public var driver: String
    public var driverName: String
    public var label: String
    /// How full the bar is, 0…1
    public var fill: Double
    public var band: PlanUsageBand
    /// Show the "exactly 100% by the reset" tick (projected mode, once there's enough of the window to project)
    public var tick: Bool
    /// "50%" or "on pace for 63% · 50% used"
    public var valueText: String
    /// "resets in 2h 14m", "resets Thu 9:00" or "Limited until 9:00"
    public var resetText: String
    public var accessibilityLabel: String
}

public struct PlanNote: Equatable, Sendable, Identifiable {
    public var id: String
    public var driver: String
    public var driverName: String
    public var text: String
    public var band: PlanUsageBand
    public var accessibilityLabel: String
}

public enum PlanUsage {
    /// The bar's tick sits here: using exactly the limit by the reset.
    public static let tickPosition = 0.8
    /// Until this much of the window has passed, a projection swings too wildly to show.
    public static let minElapsed = 0.10

    // MARK: Used so far

    public static func percentText(_ used: Double) -> String { "\(Int(used.rounded()))%" }

    /// Neutral below 75%, amber from 75%, red from 90% and at 100%.
    public static func usedBand(_ used: Double) -> PlanUsageBand {
        if used >= 90 { return .red }
        if used >= 75 { return .amber }
        return .neutral
    }

    // MARK: Projected at reset

    /// How far through the window we are, 0…1: `1 − (resetsAt − now) ÷ windowSeconds`. A reset in the past
    /// is a fresh window until the next poll brings the new one, so it counts as 0, not 1.
    public static func elapsed(_ w: PlanWindow, now: Timestamp) -> Double {
        guard w.windowSeconds > 0 else { return 0 }
        let remaining = (w.resetsAt - now) / 1000
        if remaining <= 0 { return 0 }
        return min(max(1 - remaining / w.windowSeconds, 0), 1)
    }

    /// Used ÷ elapsed (percent), or nil before `minElapsed` of the window has passed.
    public static func projected(used: Double, elapsed: Double) -> Double? {
        guard elapsed >= minElapsed - 1e-9 else { return nil }
        return used / elapsed
    }

    /// `1.2 × projected − 40`, clamped: 100% projected fills to the tick, 75% half, about 117% and up all of it.
    public static func projectedFill(_ projected: Double) -> Double {
        min(max((1.2 * projected - 40) / 100, 0), 1)
    }

    /// Green up to 90% projected, amber to 100%, red over.
    public static func projectedBand(_ projected: Double) -> PlanUsageBand {
        if projected > 100 { return .red }
        if projected > 90 { return .amber }
        return .green
    }

    // MARK: Reset text

    public static func resetText(resetsAt: Timestamp, now: Timestamp, limited: Bool, calendar: Calendar = .current) -> String {
        let secs = (resetsAt - now) / 1000
        if secs <= 0 { return limited ? "Limited until reset" : "just reset" }
        let when = secs < 86_400 ? timeText(resetsAt, calendar: calendar) : weekdayTimeText(resetsAt, calendar: calendar)
        if limited { return "Limited until \(when)" }
        if secs < 86_400 { return "resets in \(durationText(secs))" }
        return "resets \(when)"
    }

    /// "2h 14m", "14m", "1h" (minutes round up, so it never reads "0m" with time left).
    public static func durationText(_ secs: Double) -> String {
        let minutes = max(Int((secs / 60).rounded(.up)), 1)
        let h = minutes / 60, m = minutes % 60
        if h == 0 { return "\(m)m" }
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }

    private static func timeText(_ ms: Timestamp, calendar: Calendar) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let c = calendar.dateComponents([.hour, .minute], from: d)
        return String(format: "%d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    private static func weekdayTimeText(_ ms: Timestamp, calendar: Calendar) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let wd = calendar.component(.weekday, from: d)
        let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return "\(names[(wd - 1) % 7]) \(timeText(ms, calendar: calendar))"
    }

    /// "updated 3m ago"
    public static func updatedText(fetchedAt: Timestamp, now: Timestamp) -> String {
        let secs = max((now - fetchedAt) / 1000, 0)
        if secs < 60 { return "updated just now" }
        let minutes = Int(secs / 60)
        return minutes < 60 ? "updated \(minutes)m ago" : "updated \(minutes / 60)h ago"
    }

    // MARK: Rows

    /// Driver ids with a row, for the filter menu, with their names.
    public static func drivers(_ report: PlanUsageReport?) -> [(id: String, name: String)] {
        (report?.drivers ?? []).map { ($0.driver, $0.name) }
    }

    public static func rows(
        _ report: PlanUsageReport?,
        filter: PlanUsageFilter,
        mode: PlanUsageMode,
        now: Timestamp,
        calendar: Calendar = .current
    ) -> [PlanUsageRow] {
        guard let report else { return [] }
        let drivers: [DriverPlanUsage]
        switch filter {
        case .hide: return []
        case .all: drivers = report.drivers
        case let .driver(id): drivers = report.drivers.filter { $0.driver == id }
        }
        return drivers.flatMap { rows($0, mode: mode, now: now, calendar: calendar) }
    }

    static func rows(_ d: DriverPlanUsage, mode: PlanUsageMode, now: Timestamp, calendar: Calendar) -> [PlanUsageRow] {
        let updated = updatedText(fetchedAt: d.fetchedAt, now: now)
        if !d.windows.isEmpty {
            return d.windows.map { .gauge(gauge($0, of: d, mode: mode, now: now, updated: updated, calendar: calendar)) }
        }
        // Nothing to draw a bar from: say why, or how close the CLI says the account is.
        if let error = d.error, !error.isEmpty {
            return [.note(PlanNote(id: d.driver, driver: d.driver, driverName: d.name, text: error, band: .neutral,
                                   accessibilityLabel: "\(d.name): \(error)"))]
        }
        switch d.status {
        case .limited?:
            return [.note(PlanNote(id: d.driver, driver: d.driver, driverName: d.name, text: "Limited", band: .red,
                                   accessibilityLabel: "\(d.name): limited, \(updated)"))]
        case .nearLimit?:
            return [.note(PlanNote(id: d.driver, driver: d.driver, driverName: d.name, text: "Near limit", band: .amber,
                                   accessibilityLabel: "\(d.name): near the limit, \(updated)"))]
        default:
            return []
        }
    }

    static func gauge(_ w: PlanWindow, of d: DriverPlanUsage, mode: PlanUsageMode, now: Timestamp, updated: String, calendar: Calendar) -> PlanGauge {
        let name = w.label
        let elapsed = elapsed(w, now: now)
        // A reset in the past is a fresh window: nothing used until the next poll.
        let fresh = w.resetsAt <= now
        let used = fresh ? 0 : max(w.usedPercent, 0)
        let id = "\(d.driver).\(w.id.rawValue)"
        func make(fill: Double, band: PlanUsageBand, tick: Bool, value: String, reset: String, extra: String = "") -> PlanGauge {
            PlanGauge(id: id, driver: d.driver, driverName: d.name, label: name, fill: fill, band: band, tick: tick,
                      valueText: value, resetText: reset,
                      accessibilityLabel: "\(d.name) \(name): \(value), \(reset)\(extra), \(updated)")
        }

        if used >= 100 {
            // Limited in either mode.
            let reset = resetText(resetsAt: w.resetsAt, now: now, limited: true, calendar: calendar)
            return make(fill: 1, band: .red, tick: false, value: percentText(used), reset: reset)
        }
        let reset = resetText(resetsAt: w.resetsAt, now: now, limited: false, calendar: calendar)
        let usedFill = min(used / 100, 1)
        switch mode {
        case .usedSoFar:
            return make(fill: usedFill, band: usedBand(used), tick: false, value: percentText(used), reset: reset)
        case .projected:
            guard let p = projected(used: used, elapsed: elapsed) else {
                return make(fill: usedFill, band: usedBand(used), tick: false,
                            value: "too early to project · \(percentText(used)) used", reset: reset)
            }
            let value = "on pace for \(percentText(p)) · \(percentText(used)) used"
            let gone = "\(percentText(elapsed * 100)) of the \(unit(w.id)) gone"
            return make(fill: projectedFill(p), band: projectedBand(p), tick: true, value: value, reset: reset, extra: ", \(gone)")
        }
    }

    /// "week" for the weekly windows, "month", "window" for the 5-hour one.
    static func unit(_ id: PlanWindowId) -> String {
        switch id {
        case .sevenDay, .sevenDayOpus, .sevenDaySonnet: "week"
        case .monthly: "month"
        default: "window"
        }
    }

    // MARK: Explanation

    public static let infoText = "How much of your plan's usage limits the agents have used. Claude Code limits usage per 5-hour window and per week; when one fills, runs stop with a usage-limit error until it resets. Shared with anything else using the same account, such as Claude Code in your terminal."
    public static let projectedInfoText = "Projected at reset divides what's used by how much of the window has passed, so you can see whether the agents are on pace to run out before it resets. The tick marks using exactly 100% by the reset."
}
