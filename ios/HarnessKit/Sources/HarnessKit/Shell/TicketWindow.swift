import Foundation

/// A ticket window's identity (iPad): the ticket it opened on and its tab. The app's ticket
/// WindowGroup is keyed by it, so SwiftUI saves it with the scene and a relaunch reopens the window
/// on the same ticket. Tapping a ticket on iPad opens its window with a scene activation request
/// that carries it as an NSUserActivity (`activityType`, `userInfo`), which the new window reads
/// back with `init(userInfo:)`, as it does from the scene session's saved userInfo on relaunch.
public struct TicketWindowValue: Codable, Hashable, Sendable {
    public var key: String
    public var tab: TicketTab?

    public init(key: String, tab: TicketTab?) {
        self.key = key
        self.tab = tab
    }

    /// The ticket route a ticket scope's root holds; nil for any other route.
    public init?(route: Route?) {
        guard case let .ticket(key, tab)? = route else { return nil }
        self.init(key: key, tab: tab)
    }

    public var route: Route { .ticket(key: key, tab: tab) }

    /// The NSUserActivity type a ticket window's activation request carries (listed in NSUserActivityTypes).
    public static let activityType = "com.markhuot.harness.ticket"
    /// The activity's targetContentIdentifier, which the ticket WindowGroup's handlesExternalEvents
    /// matches. It's no substring of a harness:// link, so links never open a ticket window.
    public static let sceneMatch = "harness-ticket-window"

    public var userInfo: [String: String] {
        var info = ["key": key]
        if let tab { info["tab"] = tab.rawValue }
        return info
    }

    /// Back from an activity's userInfo; nil without a key. An unknown tab is dropped, as a
    /// link's is, and a renamed one maps to its new tab (ChangesTab.ticketTabFrom).
    public init?(userInfo: [AnyHashable: Any]?) {
        guard let key = (userInfo?["key"] as? String)?.trimmingCharacters(in: .whitespaces), !key.isEmpty else { return nil }
        let tab = ChangesTab.ticketTabFrom(userInfo?["tab"] as? String)
        self.init(key: key, tab: tab)
    }
}
