import Foundation

/// A ticket window's identity (iPad): the ticket it opened on and its tab. The app's ticket
/// WindowGroup is keyed by it, so SwiftUI saves it with the scene and a relaunch reopens the window
/// on the same ticket. Tapping a ticket on iPad opens its window with a scene activation request
/// that carries it as an NSUserActivity (`activityType`, `userInfo`), which the new window reads
/// back with `init(userInfo:)`, as it does from the scene session's saved userInfo on relaunch.
///
/// A pinned window is one torn-off tab of the ticket: it shows only `tab` (the Browser tab pinned to
/// `browserTab` when set, or the composer when `tab` is `.composer`), and the ticket's other
/// windows show a Return to this window placeholder in that tab's place (`TornOffTabs`).
public struct TicketWindowValue: Codable, Hashable, Sendable {
    public var key: String
    public var tab: TicketTab?
    /// One tab torn off into its own window, rather than the whole ticket.
    public var pinned: Bool
    /// A pinned Browser window's browser tab; nil for the whole Browser tab (its chip strip and all).
    public var browserTab: Int?

    /// The composer's tab id: only a pinned window shows it, as the message box on its own.
    public static let composer = TicketTab("composer")

    public init(key: String, tab: TicketTab?, pinned: Bool = false, browserTab: Int? = nil) {
        self.key = key
        self.pinned = pinned && tab != nil
        // A full window opens on a real tab, never the composer.
        self.tab = !self.pinned && tab == Self.composer ? nil : tab
        self.browserTab = self.pinned && tab == .browser ? browserTab : nil
    }

    private enum CodingKeys: String, CodingKey { case key, tab, pinned, browserTab }

    /// SwiftUI saves the WindowGroup's value with the scene: one saved before pinned windows has no
    /// `pinned` and is a full window.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            key: try c.decode(String.self, forKey: .key), tab: try c.decodeIfPresent(TicketTab.self, forKey: .tab),
            pinned: try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false, browserTab: try c.decodeIfPresent(Int.self, forKey: .browserTab))
    }

    /// A pinned window for `tab` (and `browserTab`) of `key`.
    public static func pinned(_ key: String, _ tab: TicketTab, browserTab: Int? = nil) -> TicketWindowValue {
        TicketWindowValue(key: key, tab: tab, pinned: true, browserTab: browserTab)
    }

    /// The ticket route a ticket scope's root holds; nil for any other route.
    public init?(route: Route?) {
        guard case let .ticket(key, tab)? = route else { return nil }
        self.init(key: key, tab: tab)
    }

    public var route: Route { .ticket(key: key, tab: tab == Self.composer ? nil : tab) }

    /// What makes two windows the same window, so opening one that's open brings it forward: the
    /// ticket for a full window (whichever tab it's on), the ticket, tab and browser tab for a
    /// pinned one. Keys compare case-insensitively.
    public var identity: String {
        let k = key.uppercased()
        guard pinned, let tab else { return k }
        return "\(k)|\(tab.rawValue)|\(browserTab.map(String.init) ?? "")"
    }

    /// The same window as `other` (`identity`).
    public func sameWindow(as other: TicketWindowValue) -> Bool { identity == other.identity }

    /// The NSUserActivity type a ticket window's activation request carries (listed in NSUserActivityTypes).
    public static let activityType = "com.markhuot.harness.ticket"
    /// The activity's targetContentIdentifier, which the ticket WindowGroup's handlesExternalEvents
    /// matches. It's no substring of a harness:// link, so links never open a ticket window.
    public static let sceneMatch = "harness-ticket-window"

    public var userInfo: [String: String] {
        var info = ["key": key]
        if let tab { info["tab"] = tab.rawValue }
        if pinned { info["pinned"] = "1" }
        if let browserTab { info["browserTab"] = String(browserTab) }
        return info
    }

    /// Back from an activity's userInfo; nil without a key. An unknown tab is dropped, as a
    /// link's is, and a renamed one maps to its new tab (ChangesTab.ticketTabFrom). A pinned window
    /// whose tab is unknown comes back as the whole ticket.
    public init?(userInfo: [AnyHashable: Any]?) {
        guard let key = (userInfo?["key"] as? String)?.trimmingCharacters(in: .whitespaces), !key.isEmpty else { return nil }
        let raw = userInfo?["tab"] as? String
        let pinned = userInfo?["pinned"] as? String == "1"
        let tab = pinned && raw == Self.composer.rawValue ? Self.composer : ChangesTab.ticketTabFrom(raw)
        let browserTab = (userInfo?["browserTab"] as? String).flatMap { Int($0) }
        self.init(key: key, tab: tab, pinned: pinned, browserTab: browserTab)
    }
}

/// Which parts of one ticket are torn off into pinned windows: what a ticket window (or the
/// pushed ticket screen) reads to show Return to this window in their place.
public struct TornOffTabs: Equatable, Sendable {
    /// Whole tabs in a window of their own (the Browser tab included when it's pinned whole).
    public private(set) var tabs: Set<TicketTab> = []
    /// Browser tabs pinned one by one.
    public private(set) var browserTabs: Set<Int> = []
    /// The composer is in a window of its own.
    public private(set) var composer = false

    public static let none = TornOffTabs()

    public init() {}

    /// The torn-off set for `key` among the open windows `windows` (full windows and other tickets'
    /// are skipped).
    public init(_ windows: some Sequence<TicketWindowValue>, key: String) {
        let k = key.uppercased()
        for w in windows where w.pinned && w.key.uppercased() == k {
            guard let tab = w.tab else { continue }
            if tab == TicketWindowValue.composer {
                composer = true
            } else if tab == .browser, let id = w.browserTab {
                browserTabs.insert(id)
            } else {
                tabs.insert(tab)
            }
        }
    }

    public var isEmpty: Bool { tabs.isEmpty && browserTabs.isEmpty && !composer }

    /// The pinned window showing `tab` here (`browserTab` within the Browser tab), if it's torn off.
    public func window(_ key: String, tab: TicketTab, browserTab: Int? = nil) -> TicketWindowValue? {
        if tab == TicketWindowValue.composer { return composer ? .pinned(key, tab) : nil }
        if tabs.contains(tab) { return .pinned(key, tab) }
        if tab == .browser, let browserTab, browserTabs.contains(browserTab) { return .pinned(key, .browser, browserTab: browserTab) }
        return nil
    }
}

extension TornOffTabs {
    /// What a torn-off thing is called in its placeholder and its window's title: the tab's label
    /// (a plugin tab's title once `pluginTabs` have loaded), "Message" for the composer and the
    /// browser tab's own label (`browserTabLabel`, else "Browser tab N") for a pinned browser tab.
    public static func name(_ tab: TicketTab, browserTab: Int? = nil, browserTabLabel: String? = nil, pluginTabs: [PluginTab]? = nil) -> String {
        if tab == TicketWindowValue.composer { return "Message" }
        if tab == .browser, let browserTab { return browserTabLabel ?? "Browser tab \(browserTab)" }
        if tab == .changes { return ChangesTab.label }
        if let b = tab.builtin { return Tabs.tabLabel[b] ?? b.rawValue }
        if let p = Tabs.parsePluginTab(tab.rawValue) {
            return pluginTabs?.first { $0.pluginId == p.pluginId && $0.id == p.tabId }?.title ?? p.tabId
        }
        return tab.rawValue
    }

    /// A pinned window's title: "A-1 · Transcript".
    public static func windowTitle(_ value: TicketWindowValue) -> String {
        guard value.pinned, let tab = value.tab else { return value.key }
        return "\(value.key) · \(name(tab, browserTab: value.browserTab))"
    }
}
