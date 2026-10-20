import Testing
import HarnessKit

@MainActor @Suite struct RouterSettingsSheetTests {
    @Test func settingsIsASheetAtCompactWidthAndLeavesTheSectionAlone() {
        let r = Router(selectedTab: .inbox)
        r.open(.tab(.settings))
        #expect(r.sheet == .settings)
        #expect(r.selectedTab == .inbox)
    }

    @Test func settingsIsASectionAtRegularWidth() {
        let r = Router()
        r.sheetIsBesideBoard = true
        r.open(.tab(.settings))
        #expect(r.sheet == nil)
        #expect(r.selectedTab == .settings)
    }

    @Test func aScreenPushedFromTheSettingsSheetLandsOnItsOwnStack() {
        let r = Router()
        r.open(.tab(.settings))
        r.push(.prompts)
        #expect(r.path(.settings) == [.prompts])
        #expect(r.path(.board) == [])
        // Opening Settings again starts at its root.
        r.open(.tab(.settings))
        #expect(r.path(.settings) == [])
    }

    @Test func openingASectionClosesTheSettingsSheet() {
        let r = Router()
        r.open(.tab(.settings))
        r.open(.tab(.board))
        #expect(r.sheet == nil)
    }

    @Test func settingsDocksAPresentedTicketSheet() {
        let r = Router()
        r.openTicket(key: "A-1", tab: nil)
        r.open(.tab(.settings))
        #expect(r.ticketSheetState == .docked)
        #expect(r.sheet == .settings)
    }
}
