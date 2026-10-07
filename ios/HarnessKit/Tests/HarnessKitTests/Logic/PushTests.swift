import Foundation
import Testing
@testable import HarnessKit

@Suite("Push")
struct PushTests {
    // MARK: Token

    @Test func tokensAreLowercaseHexWithLeadingZeros() {
        #expect(Push.hexToken(Data([0x00, 0x0a, 0xff, 0x7f, 0xB0])) == "000aff7fb0")
        #expect(Push.hexToken(Data()) == "")
    }

    // MARK: Payload

    @Test func theTicketKeyComesFromTheCustomKey() {
        let payload: [AnyHashable: Any] = ["aps": ["alert": ["title": "x"], "thread-id": "OTHER-1"], "ticketKey": "  HARNESS-342\n"]
        #expect(Push.ticketKey(payload) == "HARNESS-342")
    }

    @Test func theThreadIdStandsInWhenTheCustomKeyIsMissingOrBlank() {
        #expect(Push.ticketKey(["aps": ["thread-id": "HARNESS-7"]]) == "HARNESS-7")
        #expect(Push.ticketKey(["aps": ["thread-id": "HARNESS-7"], "ticketKey": "  "]) == "HARNESS-7")
    }

    @Test func aPayloadWithoutATicketHasNoKeyOrLink() {
        #expect(Push.ticketKey([:]) == nil)
        #expect(Push.ticketKey(["ticketKey": 42, "aps": ["alert": "hi"]]) == nil)
        #expect(Push.ticketKey(["aps": "not a dictionary"]) == nil)
        #expect(Push.link(["aps": ["alert": "hi"]]) == nil)
    }

    @Test func theLinkOpensTheTicket() {
        #expect(Push.link(["ticketKey": "HARNESS-342"]) == .push(.ticket(key: "HARNESS-342", tab: nil)))
        // A key that needs escaping still lands on that key, not a cut-off one.
        #expect(Push.link(["ticketKey": "A/B?C"]) == .push(.ticket(key: "A/B?C", tab: nil)))
    }

    // MARK: Environment

    /// A provisioning profile's shape: a CMS envelope (binary) around an XML plist.
    private func profile(aps: String?) -> Data {
        var entitlements = "<key>application-identifier</key><string>47P4ZSALX4.com.markhuot.harness</string>"
        if let aps { entitlements += "<key>aps-environment</key><string>\(aps)</string>" }
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
        <key>Name</key><string>iOS Team Provisioning Profile</string>
        <key>Entitlements</key><dict>\(entitlements)</dict>
        </dict></plist>
        """
        return Data([0x30, 0x82, 0x3a, 0x00, 0x06, 0x09, 0xff, 0x00]) + Data(xml.utf8) + Data([0xa0, 0x82, 0x0b, 0x00, 0xff])
    }

    @Test func aDevelopmentProfileMeansSandbox() {
        #expect(Push.apsEnvironment(profile: profile(aps: "development")) == "development")
        #expect(Push.environment(provisioningProfile: profile(aps: "development"), simulator: false) == .sandbox)
    }

    @Test func anAdHocProfileMeansProduction() {
        #expect(Push.environment(provisioningProfile: profile(aps: "production"), simulator: false) == .production)
    }

    @Test func noProfileMeansAnAppStoreOrTestFlightBuild() {
        #expect(Push.environment(provisioningProfile: nil, simulator: false) == .production)
    }

    @Test func theSimulatorIsAlwaysSandbox() {
        #expect(Push.environment(provisioningProfile: nil, simulator: true) == .sandbox)
        #expect(Push.environment(provisioningProfile: profile(aps: "production"), simulator: true) == .sandbox)
    }

    @Test func aProfileWithoutPushOrThatDoesNotParseFallsBackToSandbox() {
        #expect(Push.apsEnvironment(profile: profile(aps: nil)) == nil)
        #expect(Push.environment(provisioningProfile: profile(aps: nil), simulator: false) == .sandbox)
        #expect(Push.apsEnvironment(profile: Data("<?xml no plist end".utf8)) == nil)
        #expect(Push.apsEnvironment(profile: Data("<?xml version=\"1.0\"?><plist><broken</plist>".utf8)) == nil)
        #expect(Push.environment(provisioningProfile: Data([0x00, 0x01]), simulator: false) == .sandbox)
    }
}
