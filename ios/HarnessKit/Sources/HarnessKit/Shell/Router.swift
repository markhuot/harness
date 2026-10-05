import Foundation
import Observation

/// Where one window is: the selected tab, each tab's NavigationStack path, and the one sheet and
/// one full-screen cover that can be up. Every window (iPadOS scene) has its own; views bind to it
/// and deep links go through `open`.
///
/// A router has one of two scopes:
/// - `.main`, the window with the sections. With `opensTicketsInWindows` (iPad at regular width) a
///   ticket route doesn't push: it goes to `onOpenTicket`, which opens (or brings forward) that
///   ticket's own window.
/// - `.ticket`, a ticket window's: `root` is the ticket it shows, pushes land on its stack
///   (`path(.board)`), and section links go to `onSectionLink` (a main window).
///
/// Link semantics (ios/Tools/sim-check.ts relies on them): a tab link pops
/// everything above the tabs, modals included; a ticket (or any pushed) link pushes a fresh screen,
/// so opening the same ticket twice stacks two. Sheets replace each other; the scanner covers
/// whatever is up.
@MainActor
@Observable
public final class Router {
    public enum Scope: Sendable { case main, ticket }

    public let scope: Scope
    public var selectedTab: AppTab
    public private(set) var paths: [AppTab: [Route]] = [:]
    public var sheet: SheetRoute?
    public var cover: CoverRoute?

    /// Main scope: ticket routes go to `onOpenTicket` instead of pushing. The shell sets it.
    public private(set) var opensTicketsInWindows = false
    /// Main scope, with `opensTicketsInWindows`: opens a ticket route in a window of its own.
    @ObservationIgnored public var onOpenTicket: ((Route) -> Void)?

    /// Ticket scope: the ticket it shows under its stack.
    public private(set) var root: Route?
    /// Ticket scope: where a section link (`.tab`) goes, since a ticket window has no sections.
    @ObservationIgnored public var onSectionLink: ((DeepLink) -> Void)?
    /// Ticket scope: set when its ticket went away (deleted, or a draft that moved to New
    /// session), for the window to close itself.
    public private(set) var closeRequested = false

    public init(selectedTab: AppTab = .board) {
        scope = .main
        self.selectedTab = selectedTab
    }

    /// A ticket window's stack; `root` is the ticket route.
    public init(ticket root: Route) {
        scope = .ticket
        selectedTab = .board
        self.root = root
    }

    /// Applies a link. Returns the theme picks a settings link carries, for the caller to save.
    @discardableResult
    public func open(_ link: DeepLink) -> ThemePicker.ThemePrefsPatch? {
        if scope == .ticket { return openInTicket(link) }
        switch link {
        case let .tab(tab, themes):
            dismissModals()
            selectedTab = tab
            paths[tab] = []
            return themes
        case let .push(route):
            // A ticket that opens in its own window leaves this one as it is.
            if !opensInWindow(route) { dismissModals() }
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
            onSectionLink?(link)
            return themes
        case let .push(route):
            dismissModals()
            push(route)
        case let .sheet(s):
            cover = nil
            sheet = s
        case let .cover(c):
            cover = c
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

    /// Push on the selected tab's stack, or (`opensTicketsInWindows`) open a ticket in its window.
    public func push(_ route: Route) {
        if opensInWindow(route) {
            onOpenTicket?(route)
        } else {
            paths[selectedTab, default: []].append(route)
        }
    }

    public func path(_ tab: AppTab) -> [Route] { paths[tab] ?? [] }

    public func setPath(_ tab: AppTab, _ path: [Route]) { paths[tab] = path }

    public func popToRoot(_ tab: AppTab? = nil) { paths[tab ?? selectedTab] = [] }

    public func present(_ sheet: SheetRoute) { open(.sheet(sheet)) }

    public func present(_ cover: CoverRoute) { open(.cover(cover)) }

    /// A sheet that became a ticket (New session, launched): closes `sheet` unless a link already
    /// replaced it, then opens the ticket. The close matters on iPad, where the ticket opens in a
    /// window of its own and `open(.push)` leaves this window's sheet up.
    public func replace(_ sheet: SheetRoute, with route: Route) {
        if self.sheet == sheet { self.sheet = nil }
        open(.push(route))
    }

    public func dismissModals() {
        cover = nil
        sheet = nil
    }

    /// After pairing (RN `router.dismissAll(); router.replace("/board")`).
    public func showBoard() { open(.tab(.board)) }

    // MARK: Ticket windows

    private func opensInWindow(_ route: Route) -> Bool {
        guard scope == .main, opensTicketsInWindows, onOpenTicket != nil, case .ticket = route else { return false }
        return true
    }

    /// Main scope: turns opening tickets in their own windows on or off (the width changed).
    public func setOpensTicketsInWindows(_ on: Bool) {
        guard scope == .main else { return }
        opensTicketsInWindows = on
    }

    /// Ticket scope: shows `route` (another tab, or another ticket) at the root, its stack cleared.
    /// A link to a ticket whose window is already open lands here.
    public func show(_ route: Route) {
        guard scope == .ticket, case .ticket = route else { return }
        root = route
        paths[selectedTab] = []
        closeRequested = false
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

    /// Takes the last ticket screen whose key matches off the selected stack. When it's a ticket
    /// window's root, the window is asked to close. False when none matched.
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
        closeRequested = true
        return true
    }

    private static func lastTicket(in path: [Route], where matches: (String) -> Bool) -> Int? {
        path.lastIndex { if case let .ticket(k, _) = $0 { matches(k) } else { false } }
    }
}
