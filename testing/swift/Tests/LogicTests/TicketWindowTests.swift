import Foundation
import Testing
import HarnessKit

@Suite("Ticket windows") struct TicketWindowTests {
    @Test func aSavedPinnedComposerWindowComesBackAsTheWholeTicket() throws {
        let saved = #"{"key":"A-1","tab":"composer","pinned":true}"#.data(using: .utf8)!
        let value = try JSONDecoder().decode(TicketWindowValue.self, from: saved)
        #expect(value.tab == nil)
        #expect(!value.pinned)
        #expect(value.identity == "A-1")

        let fromActivity = TicketWindowValue(userInfo: ["key": "A-1", "tab": "composer", "pinned": "1"])
        #expect(fromActivity?.pinned == false)
        #expect(fromActivity?.tab == nil)
    }

    @Test func aSavedPinnedTabStaysPinned() throws {
        let saved = #"{"key":"A-1","tab":"transcript","pinned":true}"#.data(using: .utf8)!
        let value = try JSONDecoder().decode(TicketWindowValue.self, from: saved)
        #expect(value.pinned)
        #expect(value.tab == .transcript)
    }
}
