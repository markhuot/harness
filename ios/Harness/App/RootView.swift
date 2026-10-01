import HarnessKit
import SwiftUI

/// The app shell (mobile/app/_layout.tsx, (tabs)/_layout.tsx, index.tsx): holds the launch UI
/// until the Keychain has loaded, shows Connect without an active server and the tabs with one,
/// presents the Router's sheet and cover, routes harness:// links, applies the theme, and forwards
/// scene phases to the store.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase

    #if DEBUG
    /// `-debugScreen highlight` (or `pickers`) on the launch command line opens a debug screen directly
    /// (`browser:<KEY>` and `plugin:<KEY>:<pluginId>:<tabId>`: BrowserPluginDebugScreen; `content`,
    /// once paired: ContentPreviewView).
    @AppStorage("debugScreen") private var debugScreen = ""
    #endif

    var body: some View {
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
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active: app.sceneBecameActive()
                case .background: app.sceneDidEnterBackground()
                default: break
                }
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

    private var sheetBinding: Binding<SheetRoute?> {
        Binding(get: { router.sheet }, set: { router.sheet = $0 })
    }

    /// The cover is presented by whichever level is on top: the sheet when one is up, else the root.
    private func coverBinding(whenSheet: Bool) -> Binding<CoverRoute?> {
        Binding(get: { (router.sheet != nil) == whenSheet ? router.cover : nil }, set: { router.cover = $0 })
    }
}

/// The tab bar: Board, Inbox (badge: triage sessions triaging or busy), Settings, and Search in
/// the search role. Each tab has its own NavigationStack bound to the Router's path for it.
struct MainTabs: View {
    @Environment(Router.self) private var router
    @Environment(BoardStore.self) private var store

    var body: some View {
        @Bindable var router = router
        let triaging = store.state.triageSessions().filter { $0.triageStatus == .triaging || $0.busy }.count
        TabView(selection: $router.selectedTab) {
            Tab("Board", systemImage: "rectangle.split.3x1", value: AppTab.board) {
                TabStack(tab: .board) { BoardScreen(mode: .board) }
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                TabStack(tab: .inbox) { InboxScreen() }
            }
            .badge(triaging)
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
                TabStack(tab: .settings) { SettingsScreen() }
            }
            Tab(value: AppTab.search, role: .search) {
                TabStack(tab: .search) { BoardScreen(mode: .search) }
            }
        }
    }
}

/// One tab's NavigationStack, bound to `router.paths[tab]`, with every pushed Route's screen.
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
