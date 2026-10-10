import Foundation
import Testing
@testable import HarnessKit

@Suite("Context gauge")
struct ContextGaugeTests {
    static func usage(input: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0, prefix: Int = 50_000,
                      estimated: Bool = false, misses: Int = 0, missTokens: Int = 0) -> ContextUsage {
        ContextUsage(input: input, cacheRead: cacheRead, cacheWrite: cacheWrite, prefix: prefix, at: 1,
                     estimated: estimated, misses: misses, missTokens: missTokens)
    }

    static func gauge(_ u: ContextUsage?, limit: Int = 250_000) -> ContextGauge { ContextGauge(usage: u, limit: limit) }

    static func driver(compact: Bool? = nil, newSession: Bool? = nil, reports: Bool? = true) -> DriverInfo {
        DriverInfo(id: "d", name: "D", description: "", available: true, authenticated: true, detail: "", supportsLogin: false,
                   sessionActions: compact == nil && newSession == nil ? nil : SessionActions(compact: compact ?? false, newSession: newSession ?? false),
                   reportsContextUsage: reports)
    }

    // MARK: Tokens

    @Test(arguments: [
        (0, "0"), (950, "950"), (999, "999"), (1_000, "1k"), (1_499, "1k"), (1_500, "2k"), (82_000, "82k"),
        (249_600, "250k"), (999_499, "999k"), (999_500, "1M"), (1_000_000, "1M"), (1_200_000, "1.2M"),
        (1_249_999, "1.2M"), (2_000_000, "2M"), (-5, "0"),
    ])
    func formatsTokens(_ n: Int, _ expected: String) {
        #expect(ContextGauge.tokens(n) == expected)
    }

    // MARK: Fill

    @Test func splitsCachedFromFresh() {
        // 61k read from the cache, 6k uncached and 15k written: 82k in all, 21k of it fresh.
        let g = Self.gauge(Self.usage(input: 6_000, cacheRead: 61_000, cacheWrite: 15_000), limit: 250_000)
        #expect(g.total == 82_000)
        #expect(abs(g.fraction - 0.328) < 1e-9)
        #expect(abs(g.cachedFraction - 61_000.0 / 250_000) < 1e-9)
        #expect(abs(g.freshFraction - 21_000.0 / 250_000) < 1e-9)
        #expect(abs(g.cachedFraction + g.freshFraction - g.fraction) < 1e-9)
        #expect(g.summary == "Context 82k of 250k: 61k cached, 21k fresh")
        #expect(g.label == "82k")
        #expect(!g.isOver)
    }

    @Test func overTheLimitClampsAndKeepsTheSplit() {
        let g = Self.gauge(Self.usage(cacheRead: 400_000, cacheWrite: 100_000))
        #expect(g.total == 500_000)
        #expect(g.isOver)
        #expect(g.fraction == 1)
        // The clamped fill still splits in proportion: 4/5 slate, 1/5 amber.
        #expect(abs(g.cachedFraction - 0.8) < 1e-9)
        #expect(abs(g.freshFraction - 0.2) < 1e-9)
        #expect(g.summary == "Context 500k of 250k: 400k cached, 100k fresh, over the limit")
    }

    @Test func exactlyAtTheLimitIsFullButNotOver() {
        let g = Self.gauge(Self.usage(cacheRead: 250_000))
        #expect(g.fraction == 1)
        #expect(!g.isOver)
        let one = Self.gauge(Self.usage(cacheRead: 250_001))
        #expect(one.isOver)
    }

    @Test func emptyIsANewSession() {
        let g = Self.gauge(nil)
        #expect(g.isEmpty)
        #expect(g.label == "New")
        #expect(g.fraction == 0)
        #expect(g.cachedFraction == 0)
        #expect(g.freshFraction == 0)
        #expect(g.prefixFraction == nil)
        #expect(!g.isOver)
        #expect(g.missBadge == nil)
        #expect(g.summary == "New session: no context yet")
    }

    @Test func aZeroTotalHasNoSplit() {
        let g = Self.gauge(Self.usage())
        #expect(g.fraction == 0)
        #expect(g.cachedFraction == 0)
        #expect(!g.isEmpty)
    }

    @Test func prefixTickSitsAtItsShareOfTheLimitAndClamps() {
        #expect(Self.gauge(Self.usage(cacheRead: 100_000, prefix: 50_000)).prefixFraction == 0.2)
        #expect(Self.gauge(Self.usage(cacheRead: 100_000, prefix: 900_000)).prefixFraction == 1)
        #expect(Self.gauge(Self.usage(cacheRead: 100_000, prefix: 0)).prefixFraction == nil)
    }

    @Test func aLimitBelowOneIsKeptPositive() {
        // A zero limit would divide by zero.
        let g = ContextGauge(usage: Self.usage(cacheRead: 10), limit: 0)
        #expect(g.limit == 1)
        #expect(g.fraction == 1)
    }

    // MARK: Estimated

    @Test func anEstimateShowsAsteriskSingleToneAndNoMisses() {
        let g = Self.gauge(Self.usage(input: 82_000, estimated: true, misses: 3, missTokens: 9_000))
        #expect(g.label == "~82k*")
        #expect(g.summary == "Context about 82k of 250k (estimated from word count)")
        #expect(g.cachedFraction == 0)
        #expect(abs(g.freshFraction - g.fraction) < 1e-9)
        #expect(g.missBadge == nil)
        #expect(g.missRow == nil)
        #expect(g.info == ContextGauge.estimatedGaugeInfo)
        #expect(Self.gauge(Self.usage(cacheRead: 1)).info == ContextGauge.gaugeInfo)
    }

    @Test func anEstimateOverTheLimitSaysSo() {
        let g = Self.gauge(Self.usage(input: 300_000, estimated: true))
        #expect(g.isOver)
        #expect(g.summary == "Context about 300k of 250k (estimated from word count), over the limit")
    }

    // MARK: Misses

    @Test func missBadgeAndRowByCount() {
        #expect(Self.gauge(Self.usage(cacheRead: 1, misses: 0)).missBadge == nil)
        #expect(Self.gauge(Self.usage(cacheRead: 1, misses: 0)).missRow == nil)
        let one = Self.gauge(Self.usage(cacheRead: 1, misses: 1, missTokens: 120_000))
        #expect(one.missBadge == "1 miss")
        #expect(one.missRow == "1 cache miss (120k tokens re-written)")
        let many = Self.gauge(Self.usage(cacheRead: 1, misses: 3, missTokens: 377_000))
        #expect(many.missBadge == "3 misses")
        #expect(many.missRow == "3 cache misses (377k tokens re-written)")
        #expect(Self.gauge(Self.usage(cacheRead: 1, misses: 5, missTokens: 1_260_000)).missRow == "5 cache misses (1.3M tokens re-written)")
    }

    // MARK: Menu

    @Test func gaugeShowsOnlyForADriverThatReportsUsage() {
        #expect(ContextGauge.isShown(driver: Self.driver(reports: true)))
        #expect(!ContextGauge.isShown(driver: Self.driver(reports: false)))
        #expect(!ContextGauge.isShown(driver: Self.driver(reports: nil)))
        #expect(!ContextGauge.isShown(driver: nil))
    }

    @Test(arguments: [
        (true, true), (true, false), (false, true), (false, false),
    ])
    func actionsFollowTheDriversCapabilities(_ compact: Bool, _ newSession: Bool) {
        let m = ContextGauge.menu(driver: Self.driver(compact: compact, newSession: newSession), busy: false, compacting: false)
        #expect(m.compact == (compact ? .enabled : .hidden))
        #expect(m.newSession == (newSession ? .enabled : .hidden))
        #expect(m.opens)
    }

    @Test func noCapabilitiesOrNoDriverHidesBothActions() {
        for driver in [Self.driver(), nil] {
            let m = ContextGauge.menu(driver: driver, busy: true, compacting: false)
            #expect(m.compact == .hidden)
            #expect(m.newSession == .hidden)
            #expect(m.opens)
        }
    }

    @Test func aRunGoingGreysTheActionsWithAReasonButNotHiddenOnes() {
        let m = ContextGauge.menu(driver: Self.driver(compact: false, newSession: true), busy: true, compacting: false)
        #expect(m.compact == .hidden)
        #expect(m.newSession == .disabled("Available when the run ends"))
        #expect(m.opens)
        #expect(!m.newSession.isEnabled)
        #expect(m.newSession.isShown)
    }

    @Test func compactingDisablesTheMenuAndEveryAction() {
        let m = ContextGauge.menu(driver: Self.driver(compact: true, newSession: true), busy: true, compacting: true)
        #expect(!m.opens)
        #expect(m.compact == .disabled("Compacting…"))
        #expect(m.newSession == .disabled("Compacting…"))
    }

    // MARK: Ticket

    @Test func readsTheTicketsContext() {
        var t = SettingsRulesTests.ticket("1", .inProgress)
        #expect(ContextGauge(ticket: t, limit: 100_000).isEmpty)
        t.context = .null
        #expect(ContextGauge(ticket: t, limit: 100_000).isEmpty)
        t.context = .value(Self.usage(cacheRead: 50_000))
        #expect(ContextGauge(ticket: t, limit: 100_000).fraction == 0.5)
    }

    // MARK: Composer while compacting

    @Test func composerPlaceholderSaysCompactingInAnyStatus() {
        for status in [TicketStatus.planning, .inProgress, .blocked, .review, .done] {
            var t = SettingsRulesTests.ticket("1", status)
            #expect(TicketDetailLogic.composerPlaceholder(t) != "Compacting…")
            t.compacting = false
            #expect(TicketDetailLogic.composerPlaceholder(t) != "Compacting…")
            t.compacting = true
            #expect(TicketDetailLogic.composerPlaceholder(t) == "Compacting…")
        }
    }

    @Test func nothingSendsWhileCompacting() {
        #expect(TicketDetailLogic.canSendMessage(text: "hi", attachments: 0, uploading: 0, sending: false, approvalPending: false))
        #expect(!TicketDetailLogic.canSendMessage(text: "hi", attachments: 0, uploading: 0, sending: false, approvalPending: false, compacting: true))
        #expect(!TicketDetailLogic.canSendMessage(text: "", attachments: 2, uploading: 0, sending: false, approvalPending: false, compacting: true))
    }

    // MARK: Limit setting

    @Test(arguments: [
        ("250000", 250_000), ("250k", 250_000), (" 250K ", 250_000), ("1.5m", 1_500_000), ("1m", 1_000_000),
        ("2.5", 10_000), ("9999", 10_000), ("5k", 10_000), ("3000000", 2_000_000), ("9m", 2_000_000), ("-4", 10_000),
        ("10k", 10_000), ("2m", 2_000_000),
    ])
    func limitRoundsAndClampsTo10kThrough2M(_ text: String, _ expected: Int) {
        #expect(SettingsRules.contextGaugeLimit(text) == expected)
    }

    @Test(arguments: ["", "  ", "k", "abc", "Infinity", "1e400", "12 tokens"])
    func limitIgnoresNonNumbers(_ text: String) {
        #expect(SettingsRules.contextGaugeLimit(text) == nil)
    }
}
