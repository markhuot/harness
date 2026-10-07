import Foundation

// System notifications on the device (DESIGN.md "Notifications"): the pieces of APNs handling
// that don't need UIKit. The app's AppDelegate hands the token here, and a tapped notification's
// userInfo, and gets back what to send and where to go.

public enum Push {
    /// The APNs device token as lowercase hex, as POST /devices takes it.
    public static func hexToken(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// The ticket a notification is about: its `ticketKey` (PUSH_TICKET_KEY), else the alert's
    /// `thread-id`, which the service sets to the same key. nil when neither names one.
    public static func ticketKey(_ userInfo: [AnyHashable: Any]) -> String? {
        if let key = clean(userInfo[Notifications.pushTicketKey]) { return key }
        if let aps = userInfo["aps"] as? [AnyHashable: Any], let key = clean(aps["thread-id"]) { return key }
        return nil
    }

    /// Where tapping the notification goes: the ticket's screen (harness://ticket/KEY), or nil.
    public static func link(_ userInfo: [AnyHashable: Any]) -> DeepLink? {
        guard let key = ticketKey(userInfo) else { return nil }
        return DeepLink.parse("\(DeepLink.scheme)://ticket/\(URIComponent.encode(key))")
    }

    private static func clean(_ value: Any?) -> String? {
        guard let s = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    // MARK: Environment

    /// Which APNs environment this build's tokens belong to. A development-signed build carries
    /// `embedded.mobileprovision`, whose entitlements name `aps-environment` ("development" →
    /// sandbox; an ad hoc profile says "production"). TestFlight and App Store builds carry no
    /// profile: production. The simulator is always sandbox.
    public static func environment(provisioningProfile: Data?, simulator: Bool) -> ApnsEnvironment {
        if simulator { return .sandbox }
        guard let profile = provisioningProfile else { return .production }
        switch apsEnvironment(profile: profile) {
        case "production": return .production
        // "development", or a profile without push (it can't get a token anyway).
        default: return .sandbox
        }
    }

    /// The `aps-environment` entitlement in a provisioning profile: a CMS-signed envelope around an
    /// XML plist, so the plist is cut out of the bytes and parsed. nil when there's none.
    public static func apsEnvironment(profile: Data) -> String? {
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex) else { return nil }
        let xml = profile.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any] else { return nil }
        return entitlements["aps-environment"] as? String
    }
}
