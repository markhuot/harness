import Foundation
import Testing
import HarnessKit

private func event(_ id: String, target: String? = "t1", status: TicketEventStatus = .pending, verdict: TicketEventVerdict = .pending, at: Double = 0, source: TicketEventSource = .child) -> TicketEvent {
    TicketEvent(id: id, targetId: target, sourceKind: source, title: id, status: status, verdict: verdict, createdAt: at)
}

@Suite("Events tab") struct EventsTabTests {
    @Test func theTabShowsOnlyOnceTheTicketHasEventsAndFallsBackToSpecWhenItGoes() {
        #expect(Tabs.visibleTabs(conductor: false, subagentIds: nil, pluginTabs: nil, events: true).map(\.rawValue) == ["spec", "activity", "transcript", "events", "browser", "details"])
        #expect(Tabs.visibleTabs(conductor: false).map(\.rawValue) == ["spec", "activity", "transcript", "browser", "details"])
        #expect(Tabs.visibleTabs(conductor: true, subagentIds: ["a"], pluginTabs: nil, events: true).map(\.rawValue) == ["spec", "activity", "children", "transcript", "agents", "events", "browser", "details"])
        #expect(Tabs.effectiveTab(.events, conductor: false, pluginTabs: nil as [Tabs.PluginTabID]?) == .spec)
        #expect(Tabs.effectiveTab(.events, conductor: false, pluginTabs: nil as [Tabs.PluginTabID]?, events: true) == .events)
        // Through the Changes layer the flag reaches both.
        #expect(ChangesTab.visibleTabs(conductor: false, workdir: nil, subagents: nil, pluginTabs: [], events: true).contains(.events))
        #expect(!ChangesTab.visibleTabs(conductor: false, workdir: nil, subagents: nil, pluginTabs: []).contains(.events))
        #expect(ChangesTab.effectiveTab(.events, conductor: false, workdir: nil, pluginTabs: [], events: true) == .events)
        #expect(ChangesTab.effectiveTab(.events, conductor: false, workdir: nil, pluginTabs: []) == .spec)
        #expect(Tabs.ticketTabFrom("events") == .events)
        #expect(Tabs.tabLabel[.events] == "Events")
    }

    @Test func aTicketsRowsAreTheOnesAimedAtItAndAChiefsAddTheUnassignedOnes() {
        var state = CosState()
        state.mergeEvents([
            event("mine", at: 3),
            event("unassigned", target: nil, at: 2),
            event("other", target: "t2", at: 5),
            event("dropped", verdict: .filtered, at: 4),
            event("reminder", verdict: .filtered, at: 1, source: .schedule),
        ])
        #expect(state.rows(ticketId: "t1", chief: true).map(\.id) == ["mine", "unassigned", "reminder"])
        #expect(state.rows(ticketId: "t1", chief: false).map(\.id) == ["mine"])
        #expect(state.inbox("t1").map(\.id) == ["mine", "unassigned", "reminder"])
    }

    @Test func aLiveUpsertReplacesItsRowAndANewOneJoinsTheTop() throws {
        var state = CosState()
        state.mergeEvents([event("a", at: 1)])
        let handled = event("a", status: .handled, at: 1)
        let live = try JSONDecoder().decode(HarnessEvent.self, from: JSONEncoder().encode(CosBusEvent.eventUpserted(handled)))
        state.apply(try #require(CosBusEvent(event: live)))
        state.apply(.eventUpserted(event("b", at: 2)))
        #expect(state.rows(ticketId: "t1", chief: false).map(\.id) == ["b", "a"])
        #expect(state.rows(ticketId: "t1", chief: false).last?.status == .handled)
    }

    @Test func aReloadOfTheNewestPageOnlyDropsTheTicketsOwnRowsWhenItLeavesAHole() {
        var state = CosState()
        state.mergeEvents([event("old-1", at: 1), event("elsewhere", target: "t2", at: 1)])
        let hole = state.loadNewestEvents("t1", [event("new", at: 9)], hasOlder: true, chief: false)
        #expect(hole)
        #expect(state.events["old-1"] == nil)
        #expect(state.events["elsewhere"] != nil, "another ticket's rows stay")
    }

    @Test func aTicketsRowsSpeakOfDeliveryAndAChiefsOfVerdicts() {
        #expect(CosInboxState.waiting.label(chief: true) == "Waiting for a verdict")
        #expect(CosInboxState.waiting.label(chief: false) == "Waiting to be delivered")
        #expect(CosInboxState.escalated.label(chief: false) == "Queued for the ticket")
        #expect(CosInboxState.reviewed.label(chief: false) == "Delivered")
        #expect(CosInboxState.needsUser.label(chief: true) == "Needs you")
        #expect(CosInboxState.ignored.label(chief: false) == CosInboxState.ignored.label(chief: true))
        #expect(CosLogic.sourceLabel(.subscription) == "Subscription")
        #expect(CosLogic.sourceLabel(.child) == "Child")
    }

    @Test func theRetentionFieldRoundsAndClampsToADayThroughAYearAndIgnoresText() {
        #expect(SettingsRules.eventRetentionDays("30") == 30)
        #expect(SettingsRules.eventRetentionDays(" 7 ") == 7)
        #expect(SettingsRules.eventRetentionDays("2.6") == 3)
        #expect(SettingsRules.eventRetentionDays("0") == 1)
        #expect(SettingsRules.eventRetentionDays("-4") == 1)
        #expect(SettingsRules.eventRetentionDays("9999") == 365)
        #expect(SettingsRules.eventRetentionDays("") == nil)
        #expect(SettingsRules.eventRetentionDays("soon") == nil)
    }
}
