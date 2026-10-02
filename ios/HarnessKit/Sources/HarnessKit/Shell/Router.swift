import Foundation
import Observation

/// Where the app is: the selected tab, each tab's NavigationStack path, and the one sheet and one
/// full-screen cover that can be up. Views bind to it; deep links go through `open`.
///
/// Link semantics (ios/Tools/sim-check.ts relies on them): a tab link pops
/// everything above the tabs, modals included; a ticket (or any pushed) link pushes a fresh screen,
/// so opening the same ticket twice stacks two. Sheets replace each other; the scanner covers
/// whatever is up.
@MainActor
@Observable
public final class Router {
    public var selectedTab: AppTab
    public private(set) var paths: [AppTab: [Route]] = [:]
    public var sheet: SheetRoute?
    public var cover: CoverRoute?

    public init(selectedTab: AppTab = .board) {
        self.selectedTab = selectedTab
    }

    /// Applies a link. Returns the theme picks a settings link carries, for the caller to save.
    @discardableResult
    public func open(_ link: DeepLink) -> ThemePicker.ThemePrefsPatch? {
        switch link {
        case let .tab(tab, themes):
            dismissModals()
            selectedTab = tab
            paths[tab] = []
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

    /// Push on the selected tab's stack.
    public func push(_ route: Route) {
        paths[selectedTab, default: []].append(route)
    }

    public func path(_ tab: AppTab) -> [Route] { paths[tab] ?? [] }

    public func setPath(_ tab: AppTab, _ path: [Route]) { paths[tab] = path }

    public func popToRoot(_ tab: AppTab? = nil) { paths[tab ?? selectedTab] = [] }

    public func present(_ sheet: SheetRoute) { open(.sheet(sheet)) }

    public func present(_ cover: CoverRoute) { open(.cover(cover)) }

    public func dismissModals() {
        cover = nil
        sheet = nil
    }

    /// After pairing (RN `router.dismissAll(); router.replace("/board")`).
    public func showBoard() { open(.tab(.board)) }
}
