import Foundation
import Testing
@testable import HarnessKit

/// The navigation semantics ios/Tools/sim-check.ts relies on.
@MainActor
@Suite("Router")
struct RouterTests {
    @Test func aTabLinkDismissesModalsAndPopsThatTab() {
        let r = Router()
        r.open(.push(.ticket(key: "A-1", tab: nil)))
        r.open(.sheet(.newSession(projectId: nil, key: nil)))
        r.open(.cover(.scan))
        r.open(.tab(.board))
        #expect(r.sheet == nil && r.cover == nil)
        #expect(r.path(.board).isEmpty)
        #expect(r.selectedTab == .board)
    }

    @Test func aTabLinkLeavesOtherTabsStacksAlone() {
        let r = Router()
        r.open(.tab(.inbox))
        r.open(.push(.triage(sessionId: "s1")))
        r.open(.tab(.board))
        #expect(r.path(.inbox) == [.triage(sessionId: "s1")])
        r.open(.tab(.inbox))
        #expect(r.path(.inbox).isEmpty)
    }

    @Test func aPushStacksOnTheSelectedTabEvenForTheSameTicket() {
        let r = Router()
        r.open(.tab(.settings))
        r.open(.push(.prompts))
        r.open(.push(.ticket(key: "A-1", tab: .details)))
        r.open(.push(.ticket(key: "A-1", tab: .details)))
        #expect(r.path(.settings) == [.prompts, .ticket(key: "A-1", tab: .details), .ticket(key: "A-1", tab: .details)])
        #expect(r.path(.board).isEmpty)
    }

    @Test func aPushDismissesModals() {
        let r = Router()
        r.open(.sheet(.projects(fromSearch: false)))
        r.open(.push(.ticket(key: "A-1", tab: nil)))
        #expect(r.sheet == nil)
        #expect(r.path(.board) == [.ticket(key: "A-1", tab: nil)])
    }

    @Test func aSheetReplacesTheSheetAndClosesTheScanner() {
        let r = Router()
        r.open(.sheet(.connect))
        r.open(.cover(.scan))
        #expect(r.sheet == .connect && r.cover == .scan)
        r.open(.sheet(.watcher(id: "w1")))
        #expect(r.sheet == .watcher(id: "w1") && r.cover == nil)
    }

    @Test func settingsThemesAreHandedBack() {
        let r = Router()
        var applied: ThemePicker.ThemePrefsPatch?
        #expect(r.open(url: URL(string: "harness://settings?theme=light")!) { applied = $0 })
        #expect(applied == ThemePicker.ThemePrefsPatch(theme: .light))
        #expect(r.selectedTab == .settings)
        applied = nil
        #expect(r.open(url: URL(string: "harness://settings")!) { applied = $0 })
        #expect(applied == nil)
        #expect(!r.open(url: URL(string: "https://example.com")!))
    }
}
