import HarnessKit
import SwiftUI

/// The main window's shell: holds the launch UI
/// until the Keychain has loaded, shows Connect without an active server and the sections with
/// one, and (through SceneChrome) presents the Router's sheet and cover, routes harness:// links
/// and applies the theme. The app forwards scene phases to the store (HarnessApp).
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @State private var scene: UIWindowScene?

    #if DEBUG
    /// `-debugScreen highlight` (or `pickers`) on the launch command line opens a debug screen directly
    /// (`browser:<KEY>` and `plugin:<KEY>:<pluginId>:<tabId>`: BrowserPluginDebugScreen; `content`,
    /// once paired: ContentPreviewView).
    @AppStorage("debugScreen") private var debugScreen = ""
    #endif

    var body: some View {
        content
            .sceneChrome(router)
            // Links from outside the app land in a main window rather than a ticket window.
            .handlesExternalEvents(preferring: ["\(DeepLink.scheme)://"], allowing: ["\(DeepLink.scheme)://"])
            .background(SceneReader { s in
                scene = s
                WindowDirectory.shared.mainActive(router, scene: s)
            })
            .onAppear { WindowDirectory.shared.mainActive(router, scene: scene) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { WindowDirectory.shared.mainActive(router, scene: scene) }
            }
    }

    @ViewBuilder private var content: some View {
        #if DEBUG
        if debugScreen == "highlight" {
            NavigationStack { HighlightPreviewView() }
        } else if debugScreen == "pickers" {
            NavigationStack { RequireStore { PickerGalleryView() } }
        } else if app.active != nil, let screen = BrowserPluginDebugScreen(debugScreen) {
            NavigationStack { screen }
        } else {
            shell
        }
        #else
        shell
        #endif
    }

    @ViewBuilder private var shell: some View {
        if !app.loaded {
            LoadingScreen()
        } else if app.active == nil {
            NavigationStack { ConnectScreen() }
        } else if let store = app.store {
            #if DEBUG
            if debugScreen == "content" {
                // Needs the paired store, and the Board tab's stack so file and ticket links push.
                TabStack(tab: .board) { ContentPreviewView() }.environment(store)
            } else {
                MainTabs().environment(store)
            }
            #else
            MainTabs().environment(store)
            #endif
        } else {
            LoadingScreen()
        }
    }
}

extension View {
    /// A window's chrome, for `router`'s window: its sheet and cover, harness:// links from outside,
    /// the palette, tint, toasts and color scheme, and the bar titles' color (BarAppearance).
    func sceneChrome(_ router: Router) -> some View { modifier(SceneChrome(router: router)) }
}

private struct SceneChrome: ViewModifier {
    let router: Router

    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// What the bar colors depend on: both appearances' text (BarAppearance).
    private var barColorKey: String {
        [false, true].map { dark in
            "\(Palette(app.resolvedTheme(systemDark: dark)).tokens[.text])"
        }.joined(separator: " | ")
    }

    func body(content: Content) -> some View {
        let palette = Palette(app.resolvedTheme(systemDark: scheme == .dark))
        content
            .sheet(item: sheetBinding) { sheet in
                SheetHost(sheet: sheet)
                    .fullScreenCover(item: coverBinding(whenSheet: true)) { CoverHost(cover: $0) }
            }
            .fullScreenCover(item: coverBinding(whenSheet: false)) { CoverHost(cover: $0) }
            .environment(\.palette, palette)
            .tint(palette.accent)
            .toastOverlay()
            .background(palette.bg.ignoresSafeArea())
            // Alerts, action sheets, sheets and the keyboard follow Settings → Appearance.
            .preferredColorScheme(app.prefs.theme == .system ? nil : app.prefs.theme == .dark ? .dark : .light)
            .onOpenURL { url in router.open(url: url, applyThemes: app.applyThemes) }
            // Navigation titles in the theme's text color (BarAppearance).
            .onChange(of: barColorKey, initial: true) {
                BarAppearance.apply(light: Palette(app.resolvedTheme(systemDark: false)), dark: Palette(app.resolvedTheme(systemDark: true)))
            }
            .environment(router)
    }

    /// At regular width the Projects sheet is the split view's sidebar column (MainTabs shows it
    /// and clears the route), so it never comes up as a sheet there.
    private var sheetBinding: Binding<SheetRoute?> {
        Binding(get: {
            if sizeClass == .regular, case .projects? = router.sheet { return nil }
            return router.sheet
        }, set: { router.sheet = $0 })
    }

    /// The cover is presented by whichever level is on top: the sheet when one is up, else the root.
    private func coverBinding(whenSheet: Bool) -> Binding<CoverRoute?> {
        Binding(get: { (router.sheet != nil) == whenSheet ? router.cover : nil }, set: { router.cover = $0 })
    }
}

/// The selected section (Board, Inbox or Settings) in its own NavigationStack. There's no tab bar.
/// At compact width (iPhone, and iPad Split View when narrow) the Projects sidebar, behind each
/// section's sidebar button, switches between them; the board has no header, and its own bottom
/// bar holds that button, the search field (with the filter inside it) and New session. At regular width (iPad) it's DesktopShell, where a ticket opens
/// in a window of its own (WindowDirectory.openTicket) instead of on the section's stack.
struct MainTabs: View {
    @Environment(Router.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.supportsMultipleWindows) private var multipleWindows

    var body: some View {
        Group {
            if sizeClass == .regular {
                DesktopShell()
            } else {
                SectionStack()
            }
        }
        .onChange(of: sizeClass == .regular && multipleWindows, initial: true) { _, windows in
            router.setOpensTicketsInWindows(windows)
        }
    }
}

/// The selected section's stack.
private struct SectionStack: View {
    @Environment(Router.self) private var router

    var body: some View {
        switch router.selectedTab {
        case .board: TabStack(tab: .board) { BoardScreen() }
        case .inbox: TabStack(tab: .inbox) { InboxScreen() }
        case .settings: TabStack(tab: .settings) { SettingsScreen() }
        }
    }
}

/// The iPad's desktop layout: the Projects sidebar as a split view's sidebar column next to the
/// selected section, hidden and shown by the system toggle and remembered in prefs
/// (`sidebarHidden`). The sections put search and their actions in the top bar
/// (`\.desktopShell`). `harness://projects` shows the sidebar instead of a sheet.
private struct DesktopShell: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        NavigationSplitView(columnVisibility: visibility) {
            ProjectsSidebar(column: true)
                .background(c.bgSidebar.ignoresSafeArea())
                .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 360)
        } detail: {
            // The column paints the system background; the phone's sections show RootView's `bg`.
            SectionStack().environment(\.desktopShell, true).background(c.bg.ignoresSafeArea())
        }
        // Side by side in portrait too, like the Mac's sidebar, rather than over the section.
        .navigationSplitViewStyle(.balanced)
        .onChange(of: router.sheet, initial: true) { _, sheet in
            guard case .projects? = sheet else { return }
            router.sheet = nil
            app.setPref(\.sidebarHidden, false)
        }
    }

    private var visibility: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { app.prefs.sidebarHidden == true ? .detailOnly : .all },
            set: { v in
                let hidden = v == .detailOnly
                if (app.prefs.sidebarHidden == true) != hidden { app.setPref(\.sidebarHidden, hidden) }
            })
    }
}

extension EnvironmentValues {
    /// Inside the iPad's DesktopShell: the split view's toggle replaces the sidebar button, and the
    /// board's search, filter and New session sit in the top bar instead of a bottom bar.
    @Entry var desktopShell = false
}

/// The header button that opens the Projects sidebar, on each section's root screen. Its amber
/// badge counts the triage sessions triaging or busy, like the sidebar's Inbox row, so the tab
/// bar's old Inbox badge still shows from every section. None in the iPad's DesktopShell, where
/// the split view's own toggle shows the sidebar and its Inbox row carries the badge. The phone's
/// board has no header and puts ProjectsButton in its own bottom bar (BoardBottomBar).
struct SidebarToolbarItem: ToolbarContent {
    @Environment(\.desktopShell) private var desktop

    var body: some ToolbarContent {
        if !desktop {
            ToolbarItem(placement: .topBarLeading) { ProjectsButton() }
        }
    }
}

/// The sidebar glyph that opens the Projects sheet, with the amber triaging badge. `circle` draws
/// it as a glass circle of its own, for a bar that isn't a toolbar (the phone board's).
struct ProjectsButton: View {
    var circle = false
    @Environment(Router.self) private var router
    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some View {
        if circle {
            button
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .foregroundStyle(c.accent)
        } else {
            button
        }
    }

    private var button: some View {
        let triaging = store.state.triageSessions().filter { $0.triageStatus == .triaging || $0.busy }.count
        return Button { router.present(.projects) } label: {
            Image(systemName: "sidebar.left")
                .font(circle ? .system(size: 19, weight: .medium) : nil)
                .frame(width: circle ? 34 : nil, height: circle ? 34 : nil)
                .overlay(alignment: .topTrailing) {
                    if triaging > 0 {
                        Text("\(triaging)")
                            .font(.scaled(size: 11, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(c.onAmber)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 16, minHeight: 16)
                            .background(c.amber, in: .capsule)
                            .offset(x: 9, y: -9)
                    }
                }
        }
        .accessibilityLabel("Projects")
        .accessibilityValue(triaging > 0 ? "\(triaging) triaging" : "")
    }
}

/// One section's NavigationStack, bound to `router.paths[tab]`, with every pushed Route's screen.
struct TabStack<Root: View>: View {
    let tab: AppTab
    @ViewBuilder var root: Root
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        NavigationStack(path: Binding(get: { router.path(tab) }, set: { router.setPath(tab, $0) })) {
            root
                .navigationDestination(for: Route.self) { RouteScreen(route: $0) }
        }
    }
}
