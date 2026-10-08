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
/// sheet, so it joins the dock on top instead of stacking on the sheet. Sheets replace each other;
/// the scanner covers whatever is up.
///
/// Ticket sheets (main scope, compact and regular width alike): tickets and New session open in a
/// `TicketSheet` over the sections (iPhone) or beside them (iPad, `sheetIsBesideBoard`) instead of
/// on a section's stack. A size-class change keeps them as they are. The router keeps a list of
/// them, `dockedSheets`, most recently used first; the first is the one on top, the only one on
/// screen. `ticketSheetState` is `.presented`, `.docked` or `.gone` (the list is empty).
/// - Presented (`ticketSheet`, the top): every push lands on its own `path`, so a conductor's child
///   opens in the same sheet and Back returns to the conductor. Pushing the ticket already on top
///   only switches it to the link's tab, if it names one. A ticket pushed onto New session takes
///   its place; `replace(newSession, with: ticket)` turns New session into that ticket's sheet in
///   place.
/// - Docked (`dock`, the top): `dockSheet()` keeps the sheets, paths and all, as a bar under the
///   tabs, titled by the ticket on top (`TicketSheet.title`); `restoreDock()` presents the top
///   again as it was. A tab link docks a presented sheet instead of closing it, and changing tabs
///   keeps the dock.
/// - Opening a ticket (outside the sheet, or a link while docked or gone) or New session brings
///   forward the sheet that already shows it, else adds a new sheet on top, and presents it.
///   Nothing is dropped: `activateSheet(id:)` and `activateAdjacentSheet(_:)` switch between them.
///   Only the first `liveSheetCount` are mounted (`liveSheets`); the rest are parked, drawn as a
///   row from the board's `Ticket` until opened again at their saved path.
/// - Closing (`dismissSheet()`, `closeSheet(id:)`, `popOutSheet()` into a window) takes one sheet
///   off; when it was the top, the next becomes the top, docked. Projects closes them all.
/// Other `sheet`s (pickers…) and `cover` work as before and come up over it. A ticket window has
/// no ticket sheet: tickets push on its stack. The list survives a relaunch through
/// `persistedDock` / `restorePersistedDock(_:)`, which the app keeps on the device.
@MainActor
@Observable
public final class Router {
    public enum Scope: Sendable { case main, ticket }
    public enum TicketSheetState: Sendable { case presented, docked, gone }
    /// A swipe along the dock bar: `.next` sends the top to the back, `.previous` brings the last
    /// one to the top, so repeated swipes walk the whole dock like Safari's tab bar.
    public enum DockStep: Sendable { case next, previous }

    /// Docked sheets with their stacks mounted (instant to switch to); the rest are parked.
    public static let liveSheetCount = 5
    /// Docked sheets listed directly in the switcher and the iPad's pills; the rest go behind "+N".
    public static let shownDockCount = 10

    public let scope: Scope
    public var selectedTab: AppTab
    public private(set) var paths: [AppTab: [Route]] = [:]
    public var sheet: SheetRoute?
    public var cover: CoverRoute?

    /// The ticket sheets, most recently used first: the first is presented or docked, the rest
    /// wait in the dock. Empty when gone.
    private var sheets: [TicketSheet] = []
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
                // ticket sheets (New session drafts are saved).
                dismissAllSheets()
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

    /// `open(_:)` for a link from outside the ticket sheet: a ticket opens as a sheet's ticket
    /// (`openTicket`) rather than pushing onto a presented sheet. Everything else as `open(_:)`.
    @discardableResult
    public func openFromOutside(_ link: DeepLink) -> ThemePicker.ThemePrefsPatch? {
        guard scope == .main, case let .push(.ticket(key, tab)) = link else { return open(link) }
        dismissModals()
        openTicket(key: key, tab: tab)
        return nil
    }

    /// Main scope: opens a ticket chosen outside the ticket sheet (a board card, the inbox), presented
    /// on top. A sheet showing it on top comes forward as it is (switched to `tab` if it names one);
    /// a sheet with it at the root comes forward popped back to it; otherwise a new sheet joins the
    /// dock on top. Ticket scope: `push`.
    public func openTicket(key: String, tab: TicketTab?) {
        guard scope == .main else { return push(.ticket(key: key, tab: tab)) }
        presentTicketSheet(.ticket(key: key, tab: tab))
    }

    /// Main scope: push on the presented ticket sheet, or open a ticket in one, else push on the
    /// selected tab's stack. Ticket scope: push on its stack.
    public func push(_ route: Route) {
        if scope == .main, var s = ticketSheet {
            if case let .ticket(key, tab) = route, case .newSession = s.root {
                // A ticket opened from New session takes its place, unless another sheet shows it.
                if sheets.dropFirst().contains(where: { $0.shows(.ticket(key: key, tab: tab)) || $0.rootKey == key }) {
                    presentTicketSheet(.ticket(key: key, tab: tab))
                } else {
                    s.root = .ticket(key: key, tab: tab)
                    s.path = []
                    sheets[0] = s
                }
            } else if case let .ticket(key, tab) = route, s.showsOnTop(key) {
                // Already on top: a link to one of its tabs switches to it rather than stacking a copy.
                if let tab, s.showTab(tab) { sheets[0] = s }
            } else {
                s.path.append(route)
                sheets[0] = s
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
    /// ticket's in place (wherever it is in the dock, docked or not), unless something else replaced
    /// it. Otherwise closes `sheet` unless a link already replaced it, then opens the ticket.
    public func replace(_ sheet: SheetRoute, with route: Route) {
        if case let .newSession(projectId, key) = sheet, case let .ticket(k, tab) = route,
           let i = sheets.firstIndex(where: { $0.root == .newSession(projectId: projectId, key: key) }) {
            var s = sheets[i]
            s.root = .ticket(key: k, tab: tab)
            s.path = []
            sheets[i] = s
            return
        }
        if self.sheet == sheet { self.sheet = nil }
        open(.push(route))
    }

    /// Closes `sheet` (a `sheet`, or New session's ticket sheet wherever it is in the dock) unless a
    /// link already replaced it.
    public func close(_ sheet: SheetRoute) {
        if self.sheet == sheet {
            self.sheet = nil
        } else if case let .newSession(projectId, key) = sheet,
                  let s = sheets.first(where: { $0.root == .newSession(projectId: projectId, key: key) }) {
            closeSheet(id: s.id)
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

    /// The presented ticket sheet (the top); nil when it's docked or gone.
    public var ticketSheet: TicketSheet? { ticketSheetDocked ? nil : sheets.first }

    /// The docked ticket sheet on top, for the dock bar (`id`, `title`); nil when none is docked.
    public var dock: TicketSheet? { ticketSheetDocked ? sheets.first : nil }

    /// The dock bar is on screen, for the sections to keep clear of it.
    public var showsDock: Bool { dock != nil }

    public var ticketSheetState: TicketSheetState {
        sheets.isEmpty ? .gone : ticketSheetDocked ? .docked : .presented
    }

    /// Every ticket sheet, most recently used first; the first is the top (presented or docked).
    public var dockedSheets: [TicketSheet] { sheets }

    /// The sheets whose stacks stay mounted: the `liveSheetCount` most recently used.
    public var liveSheets: [TicketSheet] { Array(sheets.prefix(Self.liveSheetCount)) }

    /// The sheets the switcher and the iPad's pills list directly: the `shownDockCount` most
    /// recently used.
    public var shownDockedSheets: [TicketSheet] { Array(sheets.prefix(Self.shownDockCount)) }

    /// The sheets past `shownDockedSheets`, behind the "+N" entry.
    public var overflowDockedSheets: [TicketSheet] { Array(sheets.dropFirst(Self.shownDockCount)) }

    /// The presented sheet's NavigationStack path (its root is `TicketSheet.root`, not on it).
    public func setTicketSheetPath(_ path: [Route]) {
        guard let top = ticketSheet else { return }
        setTicketSheetPath(path, id: top.id)
    }

    /// `setTicketSheetPath(_:)` from sheet `id`'s own stack: only the presented top's stack is the
    /// one on screen, so a hidden stack (mounted, live, behind it) changes nothing.
    public func setTicketSheetPath(_ path: [Route], id: Int) {
        guard let top = ticketSheet, top.id == id, top.path != path else { return }
        sheets[0].path = path
    }

    /// Presented → docked, paths and all.
    public func dockSheet() {
        if !sheets.isEmpty { ticketSheetDocked = true }
    }

    /// Docked → presented, the top as it was.
    public func restoreDock() { ticketSheetDocked = false }

    /// Makes sheet `id` the top, presented or docked as the top was.
    public func activateSheet(id: Int) {
        guard let i = sheets.firstIndex(where: { $0.id == id }), i > 0 else { return }
        var list = sheets
        list.insert(list.remove(at: i), at: 0)
        sheets = list
    }

    /// The next or previous docked sheet becomes the top (a swipe along the dock bar).
    public func activateAdjacentSheet(_ step: DockStep) {
        guard sheets.count > 1 else { return }
        var list = sheets
        switch step {
        case .next: list.append(list.removeFirst())
        case .previous: list.insert(list.removeLast(), at: 0)
        }
        sheets = list
    }

    /// The top sheet closes: the next becomes the top, docked; the last one leaves nothing.
    public func dismissSheet() {
        guard let top = sheets.first else { return }
        closeSheet(id: top.id)
    }

    /// Closes sheet `id`. When it was the top, the next becomes the top, docked.
    public func closeSheet(id: Int) {
        keepSheets(sheets.filter { $0.id != id })
    }

    /// Every ticket sheet → gone (Projects).
    public func dismissAllSheets() { keepSheets([]) }

    /// `popOutSheet()` would do something: there's a window opener and a ticket sheet, presented or
    /// docked, with a ticket in it. For the UI to hide its pop-out button otherwise.
    public var canPopOutSheet: Bool { onOpenTicket != nil && sheets.first?.topTicket != nil }

    /// The top sheet → the ticket on top in a window of its own, that sheet closed. The ticket on
    /// top is the last ticket screen on the sheet's path (with its tab), so a file or other screen
    /// pushed above it pops out as its ticket; with no ticket pushed, the sheet's root ticket. New
    /// session with no ticket pushed, or no `onOpenTicket`, does nothing and keeps the sheet.
    public func popOutSheet() {
        guard let open = onOpenTicket, let top = sheets.first, let route = top.topTicket else { return }
        closeSheet(id: top.id)
        open(route)
    }

    /// Replaces the list with `kept` (the same sheets less some): when the top went, the next is
    /// the top, docked.
    private func keepSheets(_ kept: [TicketSheet]) {
        let top = sheets.first?.id
        sheets = kept
        if kept.isEmpty { ticketSheetDocked = false } else if kept.first?.id != top { ticketSheetDocked = true }
    }

    /// Presents `root` on top: the sheet already showing it on top comes forward (switched to the
    /// root's tab if it names one), else one with its ticket at the root comes forward popped back
    /// to it, else a new sheet joins the dock on top.
    private func presentTicketSheet(_ root: TicketSheet.Root) {
        var list = sheets
        if let i = list.firstIndex(where: { $0.shows(root) }) {
            var s = list.remove(at: i)
            if case let .ticket(key, tab?) = root, s.showsOnTop(key) { _ = s.showTab(tab) }
            list.insert(s, at: 0)
        } else if case let .ticket(key, tab) = root, let i = list.firstIndex(where: { $0.rootKey == key }) {
            var s = list.remove(at: i)
            s.path = []
            if let tab { s.root = .ticket(key: key, tab: tab) }
            list.insert(s, at: 0)
        } else {
            nextTicketSheetID += 1
            list.insert(TicketSheet(id: nextTicketSheetID, root: root), at: 0)
        }
        if list != sheets { sheets = list }
        ticketSheetDocked = false
    }

    // MARK: A ticket screen's place on the stack

    /// Swaps the ticket screen for `key` (in every ticket sheet: the last on its path, else its
    /// root; else the last on the selected stack, else the root of a ticket scope) for `newKey`'s.
    /// Pushes `newKey` when no screen shows `key`.
    public func replaceTicket(_ key: String, with newKey: String) {
        var list = sheets
        var matched = false
        for i in list.indices {
            if let j = Self.lastTicket(in: list[i].path, where: { $0 == key }) {
                list[i].path[j] = .ticket(key: newKey, tab: nil)
                matched = true
            } else if case .ticket(key, _) = list[i].root {
                list[i].root = .ticket(key: newKey, tab: nil)
                matched = true
            }
        }
        if matched {
            sheets = list
            return
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

    /// Takes the last ticket screen whose key matches off every ticket sheet (a sheet whose root
    /// matches closes, as `closeSheet(id:)`), else off the selected stack. When it's a ticket
    /// window's root, the window is asked to close. False when none matched.
    @discardableResult
    public func removeTicket(where matches: (String) -> Bool) -> Bool {
        var kept: [TicketSheet] = []
        var matched = false
        for var s in sheets {
            if let i = Self.lastTicket(in: s.path, where: matches) {
                s.path.remove(at: i)
                matched = true
            } else if let key = s.rootKey, matches(key) {
                matched = true
                continue
            }
            kept.append(s)
        }
        if matched {
            keepSheets(kept)
            return true
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

// MARK: The dock across launches

extension Router {
    /// Where the app keeps `persistedDock` (UserDefaults, on the device only).
    public static let persistedDockKey = "harness.dockedTickets"

    /// The ticket sheets as JSON (roots, paths, order; the first is the top), for the device to keep
    /// across launches. Nil when there are none.
    public var persistedDock: String? {
        guard !sheets.isEmpty else { return nil }
        let entries = sheets.map { PersistedSheet(root: $0.root, path: $0.path) }
        guard let data = try? JSONEncoder().encode(entries) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// Brings back `persistedDock`'s sheets, docked, when this main router has none yet. An entry
    /// that no longer decodes is dropped (a path keeps the screens up to the first that doesn't);
    /// garbage restores nothing.
    public func restorePersistedDock(_ json: String?) {
        guard scope == .main, sheets.isEmpty, let json,
              let entries = try? JSONDecoder().decode(LossyList<PersistedSheet>.self, from: Data(json.utf8)).items,
              !entries.isEmpty else { return }
        sheets = entries.map { e in
            nextTicketSheetID += 1
            return TicketSheet(id: nextTicketSheetID, root: e.root, path: e.path)
        }
        ticketSheetDocked = true
    }

    /// `persistedDock` read from and written to `defaults`.
    public func restorePersistedDock(from defaults: any ChangesDefaults) {
        restorePersistedDock(defaults.string(forKey: Self.persistedDockKey))
    }

    public func savePersistedDock(to defaults: any ChangesDefaults) {
        defaults.setString(persistedDock ?? "", forKey: Self.persistedDockKey)
    }
}

/// One saved ticket sheet. The root must decode; the path keeps the routes up to the first that
/// doesn't (one an older or newer build wrote), so what's left still makes sense as a stack.
private struct PersistedSheet: Codable {
    var root: TicketSheet.Root
    var path: [Route]

    init(root: TicketSheet.Root, path: [Route]) {
        self.root = root
        self.path = path
    }

    private enum CodingKeys: String, CodingKey { case root, path }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        root = try c.decode(TicketSheet.Root.self, forKey: .root)
        path = []
        guard var routes = try? c.nestedUnkeyedContainer(forKey: .path) else { return }
        while !routes.isAtEnd, let route = try? routes.decode(Route.self) { path.append(route) }
    }
}

/// An array whose elements that fail to decode are skipped.
private struct LossyList<Element: Decodable>: Decodable {
    var items: [Element] = []

    private struct Skip: Decodable { init(from decoder: any Decoder) throws {} }

    init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        while !c.isAtEnd {
            if let item = try? c.decode(Element.self) { items.append(item) } else { _ = try? c.decode(Skip.self) }
        }
    }
}

/// One of the main window's ticket sheets (`Router.dockedSheets`; the top is `Router.ticketSheet`
/// or `Router.dock`): a ticket with the screens pushed above it, or New session.
public struct TicketSheet: Hashable, Sendable, Identifiable {
    public enum Root: Hashable, Sendable, Codable {
        case ticket(key: String, tab: TicketTab?)
        case newSession(projectId: String?, key: String?)
    }

    /// Stays the same while the sheet docks, restores, switches, or changes content in place.
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

    /// The root's ticket key; nil for New session.
    public var rootKey: String? {
        if case let .ticket(key, _) = root { return key }
        return nil
    }

    /// The plain name (accessibility, the panel's title): the top ticket's key, or "New session".
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
