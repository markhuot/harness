import Testing
import HarnessKit

@MainActor @Suite struct RouterChiefLinkTests {
    @Test func onlyAChiefsOwnKeyIsAChiefKey() {
        #expect(CosLogic.isChiefKey("COS-1"))
        #expect(CosLogic.isChiefKey("cos-12"))
        #expect(!CosLogic.isChiefKey("COS-"))
        #expect(!CosLogic.isChiefKey("COS-1A"))
        #expect(!CosLogic.isChiefKey("COSMOS-1"))
        #expect(!CosLogic.isChiefKey("HARNESS-1"))
    }

    @Test func aNotificationForAChiefsKeyOpensThatChiefsChatNotATicket() {
        let r = Router()
        r.chiefScope = { $0.uppercased() == "COS-2" ? "group:work" : nil }
        r.openFromOutside(DeepLink.parse("harness://ticket/COS-2")!)
        #expect(r.ticketSheet?.cosScope == "group:work")
        #expect(r.ticketSheet?.topTicketKey == nil)
    }

    @Test func aNotificationForAnOrdinaryTicketStillOpensTheTicket() {
        let r = Router()
        r.openFromOutside(DeepLink.parse("harness://ticket/WEB-3")!)
        #expect(r.ticketSheet?.topTicketKey == "WEB-3")
    }
}
