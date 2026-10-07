import Foundation
import Observation

/// Where one window is: the selected tab, each tab's NavigationStack path, and the one sheet and
/// one full-screen cover that can be up. Every window (iPadOS scene) has its own; views bind to it
/// and deep links go through `open`.
///
/// A router has one of two scopes:
/// - `.main`, the window with the sections. Tickets and New session open in its ticket sheet (below)
///   at every width; `popOutSheet()` hands the sheet's ticket to `onOpenTicket`, which opens (or
///   brings forward) that ticket's own window.
/// - `.ticket`, a ticket window's: `root` is the ticket it shows, pushes land on its stack
///   (`path(.board)`), and section links go to `onSectionLink` (a main window).
///
/// Link semantics (ios/Tools/sim-check.ts relies on them): a tab link pops
/// everything above the tabs, modals included (a presented ticket sheet docks); a pushed link
/// pushes a fresh screen, a ticket's on the ticket sheet (where the ticket already on top doesn't
/// stack a copy). A ticket opened from outside the sheet (`openTicket`, `openFromOutside`: a board
/// card, a notification, a link from another app) is a new choice rather than a step inside the
/// sheet, so it replaces the sheet's ticket instead of stacking on it. Sheets replace each other;
/// the scanner covers whatever is up.
///
/// Ticket sheets (main scope, compact and regular width alike): tickets and New session open in a
/// `TicketSheet` over the sections (iPhone) or beside them (iPad, `sheetIsBesideBoard`) instead of
/// on a section's stack. A size-class change keeps it as it is. `ticketSheetState` is
/// `.presented`, `.docked` or `.gone`.
/// - Presented (`ticketSheet`): every push lands on the sheet's own `path`, so a conductor's child
///   opens in the same sheet and Back returns to the conductor. A ticket opened from outside
///   (`openTicket`) becomes the sheet's root instead, its path cleared; the sheet's root ticket
///   with nothing pushed only switches to the link's tab. Pushing the ticket already on top
///   only switches it to the link's tab, if it names one. A ticket link pushes there too; New session (`present(.newSession)`) replaces
///   the sheet's content, as does a ticket pushed onto New session. `replace(newSession, with:
///   ticket)` turns New session into that ticket's sheet in place.
/// - Docked (`dock`): `dockSheet()` keeps the sheet, path and all, as a bar under the tabs, titled
///   by the ticket on top (`TicketSheet.title`); `restoreDock()` presents it again as it was. A tab
///   link docks a presented sheet instead of closing it, and changing tabs keeps the dock.
///   Opening another ticket or New session replaces the dock (drafts are saved, so nothing is
///   lost); opening the docked ticket, or the same New session, restores it.
/// - Gone: `dismissSheet()`, from either state, or `popOutSheet()` into a window.
/// There is one ticket sheet at most, presented or docked. Projects closes it; other `sheet`s
/// (pickers…) and `cover` work as before and come up over it. A ticket window has no ticket sheet:
/// tickets push on its stack.
@MainActor
@Observable
public final class Router {
    public enum Scope: Sendable { case main, ticket }
    public enum TicketSheetState: Sendable { case presented, docked, gone }

    public let scope: Scope
    public var selectedTab: AppTab
    public private(set) var paths: [AppTab: [Route]] = [:]
    public var sheet: SheetRoute?
    public var cover: CoverRoute?

    /// The ticket sheet, presented or docked; nil when gone.
    private var ticketSheetStorage: TicketSheet?
    private var ticketSheetDocked = false
    @ObservationIgnored private var nextTicketSheetID = 0

    /// Main scope: the presented ticket sheet sits beside the board (the iPad's side panel at
    /// regular width) rather than covering it (the iPhone's sheet), so the board still counts as on
    /// screen (`PresenceRules`). The view layer sets it from the width; it changes nothing else.
    public var sheetIsBesideBoard = false

    /// Main scope: opens a ticket route in a window of its own (`popOutSheet()`). Nil where the
    /// device has no windows to open. Observed, so `canPopOutSheet` follows it.
    public var onOpenTicket: ((Route) -> Void)?

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
            dockSheet()
            selectedTab = tab
            paths[tab] = []
            return themes
        case let .push(route):
            dismissModals()
            push(route)
        case let .sheet(s):
            cover = nil
            if case let .newSession(projectId, key) = s {
                sheet = nil
                presentTicketSheet(.newSession(projectId: projectId, key: key))
            } else if s == .projects {
                // Two system sheets would fight over the bottom of the screen: Projects closes the
                // ticket sheet (New session drafts are saved).
                dismissSheet()
                sheet = s
            } else {
                sheet = s
            }
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

    /// `open(DeepLink.parse(url))`; false when the URL isn't one the app routes. `fromOutside`: the
    /// URL came from outside the ticket sheet (another app, a notification), so `openFromOutside`.
    @discardableResult
    public func open(url: URL, fromOutside: Bool = false, applyThemes: (ThemePicker.ThemePrefsPatch) -> Void = { _ in }) -> Bool {
        guard let link = DeepLink.parse(url) else { return false }
        if let themes = fromOutside ? openFromOutside(link) : open(link) { applyThemes(themes) }
        return true
    }

    /// `open(_:)` for a link from outside the ticket sheet: a ticket opens as the sheet's ticket
    /// (`openTicket`) rather than pushing onto a presented sheet. Everything else as `open(_:)`.
    @discardableResult
    public func openFromOutside(_ link: DeepLink) -> ThemePicker.ThemePrefsPatch? {
        guard scope == .main, case let .push(.ticket(key, tab)) = link else { return open(link) }
        dismissModals()
        openTicket(key: key, tab: tab)
        return nil
    }

    /// Main scope: opens a ticket chosen outside the ticket sheet (a board card, the inbox).
    /// Presented, the sheet shows it at its root with its path cleared (a New session's draft is
    /// saved), keeping its id; the sheet's root ticket with nothing pushed only switches to `tab`.
    /// Docked or gone, as `push`: the docked ticket restores, anything else opens a new sheet.
    /// Ticket scope: `push`.
    public func openTicket(key: String, tab: TicketTab?) {
        guard scope == .main, var s = ticketSheet else { return push(.ticket(key: key, tab: tab)) }
        if case .ticket(key, let current) = s.root {
            s.path = []
            if let tab, tab != current { s.root = .ticket(key: key, tab: tab) }
            if s != ticketSheetStorage { ticketSheetStorage = s }
            return
        }
        s.root = .ticket(key: key, tab: tab)
        s.path = []
        ticketSheetStorage = s
    }

    /// Main scope: push on the presented ticket sheet, or open a ticket in one, else push on the
    /// selected tab's stack. Ticket scope: push on its stack.
    public func push(_ route: Route) {
        if scope == .main, var s = ticketSheet {
            if case let .ticket(key, tab) = route, case .newSession = s.root {
                presentTicketSheet(.ticket(key: key, tab: tab))
            } else if case let .ticket(key, tab) = route, s.showsOnTop(key) {
                // Already on top: a link to one of its tabs switches to it rather than stacking a copy.
                if let tab, s.showTab(tab) { ticketSheetStorage = s }
            } else {
                s.path.append(route)
                ticketSheetStorage = s
            }
        } else if scope == .main, case let .ticket(key, tab) = route {
            presentTicketSheet(.ticket(key: key, tab: tab))
        } else {
            paths[selectedTab, default: []].append(route)
        }
    }

    public func path(_ tab: AppTab) -> [Route] { paths[tab] ?? [] }

    public func setPath(_ tab: AppTab, _ path: [Route]) { paths[tab] = path }

    public func popToRoot(_ tab: AppTab? = nil) { paths[tab ?? selectedTab] = [] }

    public func present(_ sheet: SheetRoute) { open(.sheet(sheet)) }

    public func present(_ cover: CoverRoute) { open(.cover(cover)) }

    /// A sheet that became a ticket (New session, launched): New session's ticket sheet becomes the
    /// ticket's in place (docked or not), unless something else replaced it. Otherwise closes
    /// `sheet` unless a link already replaced it, then opens the ticket.
    public func replace(_ sheet: SheetRoute, with route: Route) {
        if case let .newSession(projectId, key) = sheet, case let .ticket(k, tab) = route,
           var s = ticketSheetStorage, s.root == .newSession(projectId: projectId, key: key) {
            s.root = .ticket(key: k, tab: tab)
            s.path = []
            ticketSheetStorage = s
            return
        }
        if self.sheet == sheet { self.sheet = nil }
        open(.push(route))
    }

    /// Closes `sheet` (a `sheet`, or New session's ticket sheet) unless a link already replaced it.
    public func close(_ sheet: SheetRoute) {
        if self.sheet == sheet {
            self.sheet = nil
        } else if case let .newSession(projectId, key) = sheet,
                  ticketSheetStorage?.root == .newSession(projectId: projectId, key: key) {
            dismissSheet()
        }
    }

    public func dismissModals() {
        cover = nil
        sheet = nil
    }

    /// After pairing (RN `router.dismissAll(); router.replace("/board")`).
    public func showBoard() { open(.tab(.board)) }

    // MARK: Ticket windows

    /// Ticket scope: shows `route` (another tab, or another ticket) at the root, its stack cleared.
    /// A link to a ticket whose window is already open lands here.
    public func show(_ route: Route) {
        guard scope == .ticket, case .ticket = route else { return }
        root = route
        paths[selectedTab] = []
        closeRequested = false
    }

    // MARK: Ticket sheets

    /// The presented ticket sheet; nil when it's docked or gone.
    public var ticketSheet: TicketSheet? { ticketSheetDocked ? nil : ticketSheetStorage }

    /// The docked ticket sheet, for the dock bar (`id`, `title`); nil when none is docked.
    public var dock: TicketSheet? { ticketSheetDocked ? ticketSheetStorage : nil }

    /// The dock bar is on screen, for the sections to keep clear of it.
    public var showsDock: Bool { dock != nil }

    public var ticketSheetState: TicketSheetState {
        ticketSheetStorage == nil ? .gone : ticketSheetDocked ? .docked : .presented
    }

    /// The presented sheet's NavigationStack path (its root is `TicketSheet.root`, not on it).
    public func setTicketSheetPath(_ path: [Route]) {
        guard ticketSheet != nil else { return }
        ticketSheetStorage?.path = path
    }

    /// Presented → docked, path and all.
    public func dockSheet() {
        if ticketSheetStorage != nil { ticketSheetDocked = true }
    }

    /// Docked → presented, as it was.
    public func restoreDock() { ticketSheetDocked = false }

    /// Presented or docked → gone.
    public func dismissSheet() {
        ticketSheetStorage = nil
        ticketSheetDocked = false
    }

    /// `popOutSheet()` would do something: there's a window opener and a ticket sheet, presented or
    /// docked, with a ticket in it. For the UI to hide its pop-out button otherwise.
    public var canPopOutSheet: Bool { onOpenTicket != nil && ticketSheetStorage?.topTicket != nil }

    /// Presented or docked → the ticket on top in a window of its own, the sheet gone. The ticket on
    /// top is the last ticket screen on the sheet's path (with its tab), so a file or other screen
    /// pushed above it pops out as its ticket; with no ticket pushed, the sheet's root ticket. New
    /// session with no ticket pushed, or no `onOpenTicket`, does nothing and keeps the sheet.
    public func popOutSheet() {
        guard let open = onOpenTicket, let route = ticketSheetStorage?.topTicket else { return }
        dismissSheet()
        open(route)
    }

    /// Presents `root`: restores the dock when it shows the same ticket (or New session), else
    /// replaces the presented sheet's content, else opens a new sheet in place of any dock.
    private func presentTicketSheet(_ root: TicketSheet.Root) {
        if var s = ticketSheetStorage {
            if ticketSheetDocked, s.shows(root) {
                if case let .ticket(key, tab?) = root, s.showsOnTop(key), s.showTab(tab) { ticketSheetStorage = s }
                ticketSheetDocked = false
                return
            }
            if !ticketSheetDocked {
                if s.root != root { s.root = root; s.path = [] }
                ticketSheetStorage = s
                return
            }
        }
        nextTicketSheetID += 1
        ticketSheetStorage = TicketSheet(id: nextTicketSheetID, root: root)
        ticketSheetDocked = false
    }

    // MARK: A ticket screen's place on the stack

    /// Swaps the ticket screen for `key` (the last in the ticket sheet, else its root, else the last
    /// on the selected stack, else the root of a ticket scope) for `newKey`'s. Pushes `newKey` when
    /// no screen shows `key`.
    public func replaceTicket(_ key: String, with newKey: String) {
        if var s = ticketSheetStorage {
            if let i = Self.lastTicket(in: s.path, where: { $0 == key }) {
                s.path[i] = .ticket(key: newKey, tab: nil)
                ticketSheetStorage = s
                return
            }
            if case .ticket(key, _) = s.root {
                s.root = .ticket(key: newKey, tab: nil)
                ticketSheetStorage = s
                return
            }
        }
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

    /// Takes the last ticket screen whose key matches off the ticket sheet, else the selected stack.
    /// When it's the ticket sheet's root, the sheet goes; when it's a ticket window's root, the
    /// window is asked to close. False when none matched.
    @discardableResult
    public func removeTicket(where matches: (String) -> Bool) -> Bool {
        if var s = ticketSheetStorage {
            if let i = Self.lastTicket(in: s.path, where: matches) {
                s.path.remove(at: i)
                ticketSheetStorage = s
                return true
            }
            if case let .ticket(k, _) = s.root, matches(k) {
                dismissSheet()
                return true
            }
        }
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

/// The main window's ticket sheet (`Router.ticketSheet`, `Router.dock`): a ticket with the screens
/// pushed above it, or New session.
public struct TicketSheet: Hashable, Sendable, Identifiable {
    public enum Root: Hashable, Sendable {
        case ticket(key: String, tab: TicketTab?)
        case newSession(projectId: String?, key: String?)
    }

    /// Stays the same while the sheet docks, restores, or changes content in place.
    public let id: Int
    public internal(set) var root: Root
    /// Pushed above `root`.
    public internal(set) var path: [Route] = []

    /// The ticket on top: the last one pushed, else the root's. Nil for New session with none
    /// pushed.
    public var topTicketKey: String? {
        if case let .ticket(key, _)? = topTicket { return key }
        return nil
    }

    /// The ticket on top as a route, with the tab it shows: the last ticket pushed, else the
    /// root's. Nil for New session with none pushed.
    public var topTicket: Route? {
        if let route = path.last(where: { if case .ticket = $0 { true } else { false } }) { return route }
        if case let .ticket(key, tab) = root { return .ticket(key: key, tab: tab) }
        return nil
    }

    /// The dock bar's label: the top ticket's key, or "New session".
    public var title: String { topTicketKey ?? "New session" }

    /// The screen on top is `key`'s ticket.
    func showsOnTop(_ key: String) -> Bool {
        if let last = path.last {
            if case .ticket(key, _) = last { return true }
            return false
        }
        if case .ticket(key, _) = root { return true }
        return false
    }

    /// Points the screen on top, a ticket's, at `tab`. False when it already shows it (or the top
    /// isn't a ticket).
    mutating func showTab(_ tab: TicketTab) -> Bool {
        if let last = path.last {
            guard case let .ticket(key, current) = last, current != tab else { return false }
            path[path.count - 1] = .ticket(key: key, tab: tab)
            return true
        }
        guard case let .ticket(key, current) = root, current != tab else { return false }
        root = .ticket(key: key, tab: tab)
        return true
    }

    /// Opening `root` would show this sheet's ticket on top (or the same New session).
    func shows(_ root: Root) -> Bool {
        switch root {
        case let .ticket(key, _): topTicketKey == key
        case .newSession: self.root == root
        }
    }
}
