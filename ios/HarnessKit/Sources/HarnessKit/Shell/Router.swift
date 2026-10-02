import Foundation
import Observation

/// Where one window is: the selected tab, each tab's NavigationStack path, and the one sheet and
/// one full-screen cover that can be up. Every window (iPadOS scene) has its own; views bind to it
/// and deep links go through `open`.
///
/// A router has one of two scopes:
/// - `.main`, the window with the sections. At regular width (`opensTicketsInPanel`, the iPad) a
///   ticket route opens in the slide-over `panel` instead of being pushed.
/// - `.ticket`, a ticket's own stack: the slide-over panel (its `host` is the main router) or a
///   ticket window. `root` is the ticket it shows; pushes land on its stack (`path(.board)`).
///
/// Link semantics (ios/Tools/sim-check.ts relies on them): a tab link pops
/// everything above the tabs, modals and the panel included; a ticket (or any pushed) link pushes
/// a fresh screen, so opening the same ticket twice stacks two, except that in panel mode it
/// replaces the panel. Sheets replace each other; the scanner covers whatever is up.
@MainActor
@Observable
public final class Router {
    public enum Scope: Sendable { case main, ticket }

    public let scope: Scope
    public var selectedTab: AppTab
    public private(set) var paths: [AppTab: [Route]] = [:]
    public var sheet: SheetRoute?
    public var cover: CoverRoute?

    /// Main scope: the slide-over's own router, nil while it's closed.
    public private(set) var panel: Router?
    /// Main scope: ticket routes open in `panel` instead of pushing (regular width). The shell sets it.
    public private(set) var opensTicketsInPanel = false

    /// Ticket scope: the ticket it shows under its stack.
    public private(set) var root: Route?
    /// Ticket scope, as the panel: the main router. Sheets, covers and section links go there, and
    /// closing the panel clears it there.
    public private(set) weak var host: Router?
    /// Ticket scope, as a window: where a section link (`.tab`) goes, since the window has none.
    @ObservationIgnored public var onSectionLink: ((DeepLink) -> Void)?
    /// Ticket scope, as a window: set when its ticket went away (deleted, or a draft that moved to
    /// New session), for the window to close itself.
    public private(set) var closeRequested = false

    public init(selectedTab: AppTab = .board) {
        scope = .main
        self.selectedTab = selectedTab
    }

    /// A ticket's stack: `root` is the ticket route, `host` the main router when it's the panel.
    public init(ticket root: Route, host: Router? = nil) {
        scope = .ticket
        selectedTab = .board
        self.root = root
        self.host = host
    }

    /// Applies a link. Returns the theme picks a settings link carries, for the caller to save.
    @discardableResult
    public func open(_ link: DeepLink) -> ThemePicker.ThemePrefsPatch? {
        if scope == .ticket { return openInTicket(link) }
        switch link {
        case let .tab(tab, themes):
            dismissModals()
            panel = nil
            selectedTab = tab
            paths[tab] = []
            return themes
        case let .push(route):
            dismissModals()
            if !opensInPanel(route) { panel = nil }
            push(route)
        case let .sheet(s):
            cover = nil
            sheet = s
        case let .cover(c):
            cover = c
        }
        return nil
    }

    private func openInTicket(_ link: DeepLink) -> ThemePicker.ThemePrefsPatch? {
        switch link {
        case let .tab(_, themes):
            if let host { return host.open(link) }
            onSectionLink?(link)
            return themes
        case let .push(route):
            dismissModals()
            push(route)
        case .sheet, .cover:
            if let host { return host.open(link) }
            if case let .sheet(s) = link {
                cover = nil
                sheet = s
            } else if case let .cover(c) = link {
                cover = c
            }
        }
        return nil
    }

    /// `open(DeepLink.parse(url))`; false when the URL isn't one the app routes.
    @discardableResult
    public func open(url: URL, applyThemes: (ThemePicker.ThemePrefsPatch) -> Void = { _ in }) -> Bool {
        guard let link = DeepLink.parse(url) else { return false }
        if let themes = open(link) { applyThemes(themes) }
        return true
    }

    /// Push on the selected tab's stack, or (panel mode) open a ticket in the panel.
    public func push(_ route: Route) {
        if opensInPanel(route) {
            showInPanel(route)
        } else {
            paths[selectedTab, default: []].append(route)
        }
    }

    public func path(_ tab: AppTab) -> [Route] { paths[tab] ?? [] }

    public func setPath(_ tab: AppTab, _ path: [Route]) { paths[tab] = path }

    public func popToRoot(_ tab: AppTab? = nil) { paths[tab ?? selectedTab] = [] }

    public func present(_ sheet: SheetRoute) { open(.sheet(sheet)) }

    public func present(_ cover: CoverRoute) { open(.cover(cover)) }

    public func dismissModals() {
        if let host {
            host.dismissModals()
            return
        }
        cover = nil
        sheet = nil
    }

    /// After pairing (RN `router.dismissAll(); router.replace("/board")`).
    public func showBoard() { open(.tab(.board)) }

    // MARK: The slide-over panel (main scope)

    private func opensInPanel(_ route: Route) -> Bool {
        guard scope == .main, opensTicketsInPanel, case .ticket = route else { return false }
        return true
    }

    /// Opens `route` in the panel, replacing whatever ticket (and stack) it showed.
    public func showInPanel(_ route: Route) {
        guard scope == .main else { return }
        panel = Router(ticket: route, host: self)
    }

    public func closePanel() { panel = nil }

    /// Turns panel mode on or off (the width changed). Turning it off moves an open panel's
    /// ticket and stack onto the selected section's stack, so the ticket stays on screen.
    public func setOpensTicketsInPanel(_ on: Bool) {
        guard scope == .main, on != opensTicketsInPanel else { return }
        opensTicketsInPanel = on
        if !on, let p = panel {
            panel = nil
            paths[selectedTab, default: []].append(contentsOf: (p.root.map { [$0] } ?? []) + p.path(.board))
        }
    }

    /// Closes the panel and returns the ticket to open in its own window: the one on top of the
    /// panel's stack. Nil when the panel is closed.
    public func detachPanel() -> Route? {
        guard let p = panel else { return nil }
        panel = nil
        return p.topTicket
    }

    /// Ticket scope: the ticket the stack shows on top (the last ticket pushed, else the root).
    public var topTicket: Route? {
        path(.board).last { if case .ticket = $0 { true } else { false } } ?? root
    }

    // MARK: A ticket screen's place on the stack

    /// Swaps the ticket screen for `key` (the last on the selected stack, else the root of a ticket
    /// scope) for `newKey`'s. Pushes `newKey` when no screen shows `key`.
    public func replaceTicket(_ key: String, with newKey: String) {
        let tab = selectedTab
        var path = path(tab)
        if let i = Self.lastTicket(in: path, where: { $0 == key }) {
            path[i] = .ticket(key: newKey, tab: nil)
            setPath(tab, path)
        } else if scope == .ticket, case let .ticket(k, _)? = root, k == key {
            root = .ticket(key: newKey, tab: nil)
        } else {
            push(.ticket(key: newKey, tab: nil))
        }
    }

    /// Takes the last ticket screen whose key matches off the selected stack. When it's the root of
    /// a ticket scope, the panel closes, or the window is asked to close. False when none matched.
    @discardableResult
    public func removeTicket(where matches: (String) -> Bool) -> Bool {
        let tab = selectedTab
        var path = path(tab)
        if let i = Self.lastTicket(in: path, where: matches) {
            path.remove(at: i)
            setPath(tab, path)
            return true
        }
        guard scope == .ticket, case let .ticket(k, _)? = root, matches(k) else { return false }
        if let host {
            if host.panel === self { host.panel = nil }
        } else {
            closeRequested = true
        }
        return true
    }

    private static func lastTicket(in path: [Route], where matches: (String) -> Bool) -> Int? {
        path.lastIndex { if case let .ticket(k, _) = $0 { matches(k) } else { false } }
    }
}
