import Foundation
import Testing
@testable import HarnessKit

private struct RouteInput: Decodable, Sendable {
    let pluginId: String
    let tabId: String
}

private struct IdRef: Decodable, Sendable { let id: String }

private struct EffectiveInput: Decodable, Sendable {
    struct Opts: Decodable, Sendable {
        let conductor: Bool
        let pluginTabs: [Tabs.PluginTabID]?
        let subagents: [IdRef]?
    }
    let requested: TicketTab
    let opts: Opts
}

private struct VisibleInput: Decodable, Sendable {
    let conductor: Bool
    let subagents: [IdRef]?
    let pluginTabs: [Tabs.PluginTabID]?
}

private struct NextInput: Decodable, Sendable {
    let tabs: [TicketTab]
    let current: TicketTab
    let delta: Int
}

private struct AfterSendInput: Decodable, Sendable {
    let tab: TicketTab
    let sent: Bool
}

@Suite("tabs.ts parity")
struct TabsTests {
    @Test func ticketTabsMatchTSOrder() throws {
        let ts = try Fixture.value("tabs", "ticketTabs", as: [String].self)
        #expect(Tabs.ticketTabs.map(\.rawValue) == ts)
    }

    @Test func tabLabelsMatch() throws {
        let ts = try Fixture.value("tabs", "tabLabel", as: [String: String].self)
        #expect(Dictionary(uniqueKeysWithValues: Tabs.tabLabel.map { ($0.key.rawValue, $0.value) }) == ts)
    }

    @Test(arguments: Fixture.cases("tabs", "pluginTabRouteCases", input: RouteInput.self, output: TicketTab.self))
    fileprivate func pluginTabRoute(_ c: Fixture.Case<RouteInput, TicketTab>) {
        #expect(Tabs.pluginTabRoute(c.input.pluginId, c.input.tabId) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "subagentTabRouteCases", input: String.self, output: TicketTab.self))
    func subagentTabRoute(_ c: Fixture.Case<String, TicketTab>) {
        #expect(Tabs.subagentTabRoute(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "parsePluginTabCases", input: String.self, output: Tabs.ParsedPluginTab?.self))
    func parsePluginTab(_ c: Fixture.Case<String, Tabs.ParsedPluginTab?>) {
        #expect(Tabs.parsePluginTab(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "parseSubagentTabCases", input: String.self, output: String?.self))
    func parseSubagentTab(_ c: Fixture.Case<String, String?>) {
        #expect(Tabs.parseSubagentTab(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "tabStripTabCases", input: TicketTab.self, output: TicketTab.self))
    func tabStripTab(_ c: Fixture.Case<TicketTab, TicketTab>) {
        #expect(Tabs.tabStripTab(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "isTicketTabCases", input: String?.self, output: Bool.self))
    func isTicketTab(_ c: Fixture.Case<String?, Bool>) {
        #expect(Tabs.isTicketTab(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "showsAgentsTabCases", input: [IdRef]?.self, output: Bool.self))
    fileprivate func showsAgentsTab(_ c: Fixture.Case<[IdRef]?, Bool>) {
        #expect(Tabs.showsAgentsTab(subagentIds: c.input?.map(\.id)) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "openingTabCases", input: JSONValue?.self, output: TicketTab.self))
    func openingTab(_ c: Fixture.Case<JSONValue?, TicketTab>) {
        #expect(Tabs.openingTab() == c.output)
    }

    @Test func renamedTabsMatch() throws {
        let ts = try Fixture.value("tabs", "renamedTabs", as: [String: String].self)
        #expect(Tabs.renamedTabs.mapValues(\.rawValue) == ts)
    }

    @Test(arguments: Fixture.cases("tabs", "ticketTabFromCases", input: String?.self, output: TicketTab?.self))
    func ticketTabFrom(_ c: Fixture.Case<String?, TicketTab?>) {
        #expect(Tabs.ticketTabFrom(c.input) == c.output)
    }

    /// A sent message opens the Transcript from any tab; a failed send stays put.
    @Test(arguments: Fixture.cases("tabs", "tabAfterSendCases", input: AfterSendInput.self, output: TicketTab.self))
    fileprivate func tabAfterSend(_ c: Fixture.Case<AfterSendInput, TicketTab>) {
        #expect(Tabs.tabAfterSend(c.input.tab, sent: c.input.sent) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "effectiveTabCases", input: EffectiveInput.self, output: TicketTab.self))
    fileprivate func effectiveTab(_ c: Fixture.Case<EffectiveInput, TicketTab>) {
        let o = c.input.opts
        #expect(Tabs.effectiveTab(c.input.requested, conductor: o.conductor, pluginTabs: o.pluginTabs, subagentIds: o.subagents?.map(\.id)) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "visibleTabsCases", input: VisibleInput.self, output: [TicketTab].self))
    fileprivate func visibleTabs(_ c: Fixture.Case<VisibleInput, [TicketTab]>) {
        #expect(Tabs.visibleTabs(conductor: c.input.conductor, subagentIds: c.input.subagents?.map(\.id), pluginTabs: c.input.pluginTabs) == c.output)
    }

    @Test(arguments: Fixture.cases("tabs", "nextTabCases", input: NextInput.self, output: TicketTab?.self))
    fileprivate func nextTab(_ c: Fixture.Case<NextInput, TicketTab?>) {
        #expect(Tabs.nextTab(c.input.tabs, current: c.input.current, delta: c.input.delta) == c.output)
    }

    /// JS `===` compares code units: a decomposed é names a different tab than the precomposed one,
    /// though Swift's String == would equate them.
    @Test func tabEqualityIsCodePointEquality() {
        let precomposed = TicketTab("agent:\u{E9}")
        let decomposed = TicketTab("agent:e\u{301}")
        #expect(precomposed != decomposed)
        #expect(Tabs.nextTab([precomposed, "details"], current: decomposed, delta: 1) == precomposed)
    }
}
