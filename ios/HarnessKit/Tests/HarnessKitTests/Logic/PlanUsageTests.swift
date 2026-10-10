import Foundation
import Testing
@testable import HarnessKit

@Suite("PlanUsage")
struct PlanUsageTests {
    static var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    static func ms(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int = 0) -> Timestamp {
        let date = utc.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
        return date.timeIntervalSince1970 * 1000
    }

    /// Saturday 2026-10-10 12:00 UTC
    static let now = ms(2026, 10, 10, 12)
    static let week = 604_800.0
    static let fiveHours = 18_000.0

    /// A weekly window `elapsed` of the way through.
    static func weekly(used: Double, elapsed: Double, id: PlanWindowId = .sevenDay, label: String = "Weekly") -> PlanWindow {
        PlanWindow(id: id, label: label, usedPercent: used, resetsAt: now + (1 - elapsed) * week * 1000, windowSeconds: week)
    }

    static func report(_ windows: [PlanWindow], driver: String = "claude-code", name: String = "Claude Code", status: PlanUsageStatus? = nil, error: String? = nil, fetchedAt: Timestamp = now - 180_000) -> PlanUsageReport {
        PlanUsageReport(drivers: [DriverPlanUsage(driver: driver, name: name, windows: windows, status: status, error: error, fetchedAt: fetchedAt)])
    }

    static func gauge(_ w: PlanWindow, mode: PlanUsageMode = .usedSoFar) -> PlanGauge {
        let rows = PlanUsage.rows(report([w]), filter: .all, mode: mode, now: now, calendar: utc)
        guard case let .gauge(g)? = rows.first else { Issue.record("no gauge row: \(rows)"); return PlanGauge(id: "", driver: "", driverName: "", label: "", fill: 0, band: .neutral, tick: false, valueText: "", resetText: "", accessibilityLabel: "") }
        return g
    }

    // MARK: Used so far

    @Test("the colour band: neutral under 75, amber from 75, red from 90 and at 100", arguments: [
        (0.0, PlanUsageBand.neutral), (74.9, .neutral), (75, .amber), (89.9, .amber), (90, .red), (100, .red),
    ])
    func usedBand(used: Double, band: PlanUsageBand) {
        #expect(PlanUsage.usedBand(used) == band)
    }

    @Test func percentRounds() {
        #expect(PlanUsage.percentText(62.5) == "63%")
        #expect(PlanUsage.percentText(0.2) == "0%")
    }

    @Test func usedSoFarRowShowsPercentAndFill() {
        let g = Self.gauge(Self.weekly(used: 78, elapsed: 0.5))
        #expect(g.valueText == "78%")
        #expect(g.fill == 0.78)
        #expect(g.band == .amber)
        #expect(!g.tick)
    }

    // MARK: Reset text

    @Test func resetUnderADayIsRelative() {
        #expect(PlanUsage.resetText(resetsAt: Self.now + (2 * 3600 + 14 * 60) * 1000, now: Self.now, limited: false, calendar: Self.utc) == "resets in 2h 14m")
        #expect(PlanUsage.resetText(resetsAt: Self.now + 14 * 60 * 1000, now: Self.now, limited: false, calendar: Self.utc) == "resets in 14m")
        #expect(PlanUsage.resetText(resetsAt: Self.now + 3 * 3600 * 1000, now: Self.now, limited: false, calendar: Self.utc) == "resets in 3h")
        #expect(PlanUsage.resetText(resetsAt: Self.now + 10_000, now: Self.now, limited: false, calendar: Self.utc) == "resets in 1m")
    }

    @Test func resetAfterADayIsWeekdayAndTime() {
        let thu = Self.ms(2026, 10, 15, 9)
        #expect(PlanUsage.resetText(resetsAt: thu, now: Self.now, limited: false, calendar: Self.utc) == "resets Thu 9:00")
        #expect(PlanUsage.resetText(resetsAt: Self.ms(2026, 10, 15, 9, 5), now: Self.now, limited: false, calendar: Self.utc) == "resets Thu 9:05")
    }

    @Test func limitedNamesTheTime() {
        #expect(PlanUsage.resetText(resetsAt: Self.ms(2026, 10, 10, 15), now: Self.now, limited: true, calendar: Self.utc) == "Limited until 15:00")
        #expect(PlanUsage.resetText(resetsAt: Self.ms(2026, 10, 15, 9), now: Self.now, limited: true, calendar: Self.utc) == "Limited until Thu 9:00")
    }

    @Test func updatedAgo() {
        #expect(PlanUsage.updatedText(fetchedAt: Self.now - 20_000, now: Self.now) == "updated just now")
        #expect(PlanUsage.updatedText(fetchedAt: Self.now - 180_000, now: Self.now) == "updated 3m ago")
        #expect(PlanUsage.updatedText(fetchedAt: Self.now - 2 * 3600_000, now: Self.now) == "updated 2h ago")
    }

    // MARK: Projection

    @Test func elapsedFraction() {
        #expect(abs(PlanUsage.elapsed(Self.weekly(used: 0, elapsed: 0.8), now: Self.now) - 0.8) < 1e-9)
        let fiveHour = PlanWindow(id: .fiveHour, label: "5-hour", usedPercent: 10, resetsAt: Self.now + 3600_000, windowSeconds: Self.fiveHours)
        #expect(abs(PlanUsage.elapsed(fiveHour, now: Self.now) - 0.8) < 1e-9)
    }

    @Test func aResetInThePastIsAFreshWindow() {
        let past = PlanWindow(id: .sevenDay, label: "Weekly", usedPercent: 95, resetsAt: Self.now - 60_000, windowSeconds: Self.week)
        #expect(PlanUsage.elapsed(past, now: Self.now) == 0)
        // Its stale 95% isn't shown as used or as "Limited": it has reset.
        let g = Self.gauge(past)
        #expect(g.fill == 0)
        #expect(g.band == .neutral)
        #expect(g.resetText == "just reset")
        let p = Self.gauge(past, mode: .projected)
        #expect(p.valueText == "too early to project · 0% used")
    }

    @Test func fiftyPercentUsedEightyPercentThroughProjectsTo63() {
        let g = Self.gauge(Self.weekly(used: 50, elapsed: 0.8), mode: .projected)
        #expect(g.valueText == "on pace for 63% · 50% used")
        #expect(g.band == .green)
        #expect(g.tick)
        #expect(abs(g.fill - (1.2 * 62.5 - 40) / 100) < 1e-9)
        #expect(g.accessibilityLabel.contains("80% of the week gone"))
        #expect(g.accessibilityLabel.contains("updated 3m ago"))
    }

    @Test func fiftyPercentUsedQuarterThroughProjectsTo200AndIsRedAndFull() {
        let g = Self.gauge(Self.weekly(used: 50, elapsed: 0.25), mode: .projected)
        #expect(g.valueText == "on pace for 200% · 50% used")
        #expect(g.band == .red)
        #expect(g.fill == 1)
    }

    @Test("bar fill: 100% projected reaches the tick, 75% half, 117%+ full, under 33% empty", arguments: [
        (100.0, 0.8), (75, 0.5), (120, 1), (200, 1), (116.6, 0.9992), (33, 0), (10, 0), (0, 0),
    ])
    func projectedFill(projected: Double, fill: Double) {
        #expect(abs(PlanUsage.projectedFill(projected) - fill) < 1e-4)
    }

    @Test("projected colour: green to 90, amber to 100, red over", arguments: [
        (0.0, PlanUsageBand.green), (90, .green), (90.1, .amber), (100, .amber), (100.1, .red),
    ])
    func projectedBand(projected: Double, band: PlanUsageBand) {
        #expect(PlanUsage.projectedBand(projected) == band)
    }

    @Test func tooEarlyBelowTenPercentOfTheWindow() {
        // 2% used 5% through would project to 40%; shown as used-so-far instead.
        let early = Self.gauge(Self.weekly(used: 2, elapsed: 0.0999), mode: .projected)
        #expect(early.valueText == "too early to project · 2% used")
        #expect(early.fill == 0.02)
        #expect(!early.tick)
        // At exactly 10% it projects.
        let at = Self.gauge(Self.weekly(used: 5, elapsed: 0.1), mode: .projected)
        #expect(at.valueText == "on pace for 50% · 5% used")
        #expect(at.tick)
    }

    @Test func aWindowAt100IsLimitedInBothModes() {
        let w = PlanWindow(id: .fiveHour, label: "5-hour", usedPercent: 100, resetsAt: Self.ms(2026, 10, 10, 15), windowSeconds: Self.fiveHours)
        for mode in PlanUsageMode.allCases {
            let g = Self.gauge(w, mode: mode)
            #expect(g.band == .red)
            #expect(g.fill == 1)
            #expect(g.resetText == "Limited until 15:00")
            #expect(!g.tick)
        }
    }

    // MARK: Rows and the filter

    @Test func filterStorageRoundTrips() {
        for f in [PlanUsageFilter.all, .hide, .driver("github-copilot")] {
            #expect(PlanUsageFilter(storage: f.storage) == f)
        }
        #expect(PlanUsageFilter(storage: "") == .all)
        #expect(PlanUsageFilter(storage: "garbage") == .all)
        #expect(PlanUsageFilter(storage: "driver:") == .all)
    }

    static var twoDrivers: PlanUsageReport {
        PlanUsageReport(drivers: [
            DriverPlanUsage(driver: "claude-code", name: "Claude Code", windows: [
                PlanWindow(id: .fiveHour, label: "5-hour", usedPercent: 20, resetsAt: now + 3600_000, windowSeconds: fiveHours),
                weekly(used: 30, elapsed: 0.5),
            ], fetchedAt: now),
            DriverPlanUsage(driver: "github-copilot", name: "GitHub Copilot", windows: [
                PlanWindow(id: .monthly, label: "Premium requests", usedPercent: 40, resetsAt: now + 10 * 86_400_000, windowSeconds: 30 * 86_400),
            ], fetchedAt: now),
        ])
    }

    @Test func filterPicksDrivers() {
        func ids(_ f: PlanUsageFilter) -> [String] {
            PlanUsage.rows(Self.twoDrivers, filter: f, mode: .usedSoFar, now: Self.now, calendar: Self.utc).map(\.id)
        }
        #expect(ids(.all) == ["claude-code.five_hour", "claude-code.seven_day", "github-copilot.monthly"])
        #expect(ids(.driver("github-copilot")) == ["github-copilot.monthly"])
        #expect(ids(.hide) == [])
        // A driver the report no longer has: no rows (the view says so), not a crash or another driver's rows.
        #expect(ids(.driver("anthropic-api")) == [])
    }

    @Test func noReportNoRows() {
        #expect(PlanUsage.rows(nil, filter: .all, mode: .projected, now: Self.now).isEmpty)
        #expect(PlanUsage.rows(PlanUsageReport(drivers: []), filter: .all, mode: .projected, now: Self.now).isEmpty)
    }

    @Test func anUnreadableDriverShowsItsReasonNotABar() {
        let r = Self.report([], error: "Sign in to Claude Code to see plan usage")
        let rows = PlanUsage.rows(r, filter: .all, mode: .usedSoFar, now: Self.now, calendar: Self.utc)
        guard case let .note(n)? = rows.first, rows.count == 1 else { Issue.record("expected one note: \(rows)"); return }
        #expect(n.text == "Sign in to Claude Code to see plan usage")
        #expect(n.driverName == "Claude Code")
    }

    @Test func statusWithoutPercentagesShowsTheState() {
        func note(_ s: PlanUsageStatus?) -> PlanNote? {
            let rows = PlanUsage.rows(Self.report([], status: s), filter: .all, mode: .usedSoFar, now: Self.now, calendar: Self.utc)
            if case let .note(n)? = rows.first { return n }
            return nil
        }
        #expect(note(.limited)?.text == "Limited")
        #expect(note(.limited)?.band == .red)
        #expect(note(.nearLimit)?.band == .amber)
        #expect(note(.ok) == nil)
        #expect(note(nil) == nil)
    }

    @Test func windowsWinOverAnErrorWhenBothArePresent() {
        let r = Self.report([Self.weekly(used: 10, elapsed: 0.5)], error: "stale reason")
        let rows = PlanUsage.rows(r, filter: .all, mode: .usedSoFar, now: Self.now, calendar: Self.utc)
        #expect(rows.count == 1)
        if case .note = rows[0] { Issue.record("expected a gauge") }
    }

    @Test func windowUnitsInAccessibilityText() {
        let fiveHour = PlanWindow(id: .fiveHour, label: "5-hour", usedPercent: 10, resetsAt: Self.now + 3600_000, windowSeconds: Self.fiveHours)
        #expect(Self.gauge(fiveHour, mode: .projected).accessibilityLabel.contains("80% of the window gone"))
        let month = PlanWindow(id: .monthly, label: "Premium requests", usedPercent: 10, resetsAt: Self.now + 6 * 86_400_000, windowSeconds: 30 * 86_400)
        #expect(Self.gauge(month, mode: .projected).accessibilityLabel.contains("of the month gone"))
    }
}
