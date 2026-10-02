import HarnessKit
import SwiftUI

/// The app shell: holds the launch UI
/// until the Keychain has loaded, shows Connect without an active server and the sections with
/// one, presents the Router's sheet and cover, routes harness:// links, applies the theme (bar
/// titles included, through BarAppearance), and forwards scene phases to the store.
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

    /// What the bar colors depend on: both appearances' text (BarAppearance).
    private var barColorKey: String {
        [false, true].map { dark in
            "\(Palette(app.resolvedTheme(systemDark: dark)).tokens[.text])"
        }.joined(separator: " | ")
    }

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
            // Navigation titles in the theme's text color (BarAppearance).
            .onChange(of: barColorKey, initial: true) {
                BarAppearance.apply(light: Palette(app.resolvedTheme(systemDark: false)), dark: Palette(app.resolvedTheme(systemDark: true)))
            }
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

/// The selected section (Board, Inbox or Settings) in its own NavigationStack. There's no tab bar:
/// the Projects sidebar, behind each section's sidebar button, switches between them, and the
/// board's bottom bar holds its filter, search field and New session.
struct MainTabs: View {
    @Environment(Router.self) private var router

    var body: some View {
        switch router.selectedTab {
        case .board: TabStack(tab: .board) { BoardScreen() }
        case .inbox: TabStack(tab: .inbox) { InboxScreen() }
        case .settings: TabStack(tab: .settings) { SettingsScreen() }
        }
    }
}

/// The header button that opens the Projects sidebar, on each section's root screen. Its amber
/// badge counts the triage sessions triaging or busy, like the sidebar's Inbox row, so the tab
/// bar's old Inbox badge still shows from every section.
struct SidebarToolbarItem: ToolbarContent {
    @Environment(Router.self) private var router
    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some ToolbarContent {
        let triaging = store.state.triageSessions().filter { $0.triageStatus == .triaging || $0.busy }.count
        ToolbarItem(placement: .topBarLeading) {
            Button { router.present(.projects) } label: {
                Image(systemName: "sidebar.left")
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
