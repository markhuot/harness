import Foundation

/// Which of a session's browser tabs the Browser tab shows, and the rules around it, kept pure so
/// the SwiftUI model only forwards events.
///
/// The service decides the tab a socket watches: `browser.subscribe` with a `tabId` asks for one,
/// and `newTab` or closing the watched tab moves the socket on its own. Each `browser.state` says
/// where it is now, so `shown` follows those; `select` switches ahead of the reply so frames still
/// in flight from the old tab are dropped at once. Services from before browser tabs send no ids
/// at all: nothing is filtered and the strip never shows.
public struct BrowserTabSelection: Sendable, Equatable {
    /// The tab shown (nil: not known yet, or a service without tabs).
    public private(set) var shown: Int?

    public init(shown: Int? = nil) {
        self.shown = shown
    }

    /// A browser.state arrived. True when it moved the view to another tab than the one it was
    /// showing, so the old tab's frame must go. Learning the first tab isn't a move.
    public mutating func receive(_ state: BrowserState) -> Bool {
        guard let next = state.tabId else { return false }
        defer { shown = next }
        return shown != nil && shown != next
    }

    /// The user picked tab `id`. True when that's a switch (subscribe to it and drop the frame).
    public mutating func select(_ id: Int) -> Bool {
        guard id != shown else { return false }
        shown = id
        return true
    }

    /// Whether a frame from tab `tabId` belongs on screen. Frames without an id (older services),
    /// and any frame before the shown tab is known, are kept.
    public func accepts(frameTabId tabId: Int?) -> Bool {
        guard let tabId, let shown else { return true }
        return tabId == shown
    }

    /// The tab chips to draw: every open tab, but only once there's more than one.
    public static func strip(_ state: BrowserState?) -> [BrowserTab] {
        guard let tabs = state?.tabs, tabs.count > 1 else { return [] }
        return tabs
    }

    /// Whether the service knows about tabs (a New Tab button would be ignored otherwise).
    public static func supportsTabs(_ state: BrowserState?) -> Bool {
        state?.tabs != nil
    }

    /// A tab chip's label: its title, else its URL's host, else "New Tab" for a blank page.
    public static func label(_ tab: BrowserTab) -> String {
        let title = JSCompat.trim(tab.title)
        if !title.isEmpty { return title }
        let url = JSCompat.trim(tab.url)
        if url.isEmpty || url == "about:blank" { return "New Tab" }
        if let host = URLComponents(string: url)?.host, !host.isEmpty { return host }
        return url
    }
}
