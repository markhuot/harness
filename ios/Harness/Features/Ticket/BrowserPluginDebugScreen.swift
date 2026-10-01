#if DEBUG
import HarnessKit
import SwiftUI

/// DEBUG-only screens that host BrowserTabView and PluginTabView on their own, for trying them
/// before (or without) the ticket detail screen's tab strip. Launch with
///
///     -debugScreen browser:<KEY>
///     -debugScreen plugin:<KEY>:<pluginId>:<tabId>
///
/// (RootView's `-debugScreen` switch). The plugin screen adds a probe: a document-start script
/// that records the bridge messages the page receives, read back once a second, plus buttons that
/// exercise the page → host path (openExternal, navigating away) and the theme.
struct BrowserPluginDebugScreen: View {
    enum Target: Equatable {
        case browser(key: String)
        case plugin(key: String, pluginId: String, tabId: String)
    }

    let target: Target

    /// nil when `value` isn't one of this screen's launch values.
    init?(_ value: String) {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        switch (parts.first, parts.count) {
        case ("browser", 2): target = .browser(key: parts[1].uppercased())
        case ("plugin", 4): target = .plugin(key: parts[1].uppercased(), pluginId: parts[2], tabId: parts[3])
        default: return nil
        }
    }

    @Environment(AppModel.self) private var app

    var body: some View {
        if let store = app.store {
            Host(target: target).environment(store)
        } else {
            LoadingScreen()
        }
    }

    private struct Host: View {
        let target: Target
        @Environment(BoardStore.self) private var store
        @State private var tabs: [PluginTab]?
        @State private var probe = PluginTabProbe()

        private var key: String {
            switch target {
            case let .browser(key), let .plugin(key, _, _): key
            }
        }

        var body: some View {
            let ticket = store.state.ticketByKey(key)
            Group {
                if let ticket {
                    switch target {
                    case .browser:
                        BrowserTabView(ticket: ticket)
                    case let .plugin(_, pluginId, tabId):
                        if let tab = tabs?.first(where: { $0.pluginId == pluginId && $0.id == tabId }) {
                            VStack(spacing: 0) {
                                PluginTabView(ticket: ticket, tab: tab).environment(\.pluginTabProbe, probe)
                                PluginProbePanel(probe: probe)
                            }
                        } else if tabs != nil {
                            EmptyState(icon: "globe", title: "No \(pluginId):\(tabId) tab on \(key)")
                        } else {
                            Spinner()
                        }
                    }
                } else {
                    Spinner()
                }
            }
            .pluginTabs(for: ticket, into: $tabs)
            .task(id: store.state.ready) { _ = try? await store.loadDetail(key) }
            .navigationTitle(key)
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// What the plugin debug screen hands PluginTabView: the probe script to inject, and the host it
/// built (so the panel can read the probe back).
@MainActor
@Observable
final class PluginTabProbe {
    @ObservationIgnored weak var host: PluginWebHost?

    let script = """
    (function () {
      var p = (window.__harnessProbe = { types: [], init: null, theme: null, ticket: null });
      window.addEventListener("message", function (e) {
        var m = e.data;
        if (!m || typeof m !== "object") return;
        p.types.push(m.type);
        if (m.type === "harness:init") p.init = { origin: e.origin, ticketKey: m.ticketKey, tabId: m.tabId, token: !!m.token, theme: m.theme, themeId: m.themeId, tokens: m.tokens ? Object.keys(m.tokens).length : 0 };
        if (m.type === "harness:theme") p.theme = { theme: m.theme, themeId: m.themeId };
        if (m.type === "harness:ticket") p.ticket = { key: m.ticket && m.ticket.key, status: m.ticket && m.ticket.status };
      });
    })();
    true;
    """

    static let readBack = """
    JSON.stringify({ probe: window.__harnessProbe || null, dataTheme: document.documentElement.dataset.theme || null, dataThemeId: document.documentElement.dataset.themeId || null })
    """
}

private struct PluginProbePanel: View {
    let probe: PluginTabProbe
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var c
    @State private var readout = "…"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button("Open external") {
                    run(#"window.ReactNativeWebView.postMessage(JSON.stringify({ type: "harness:openExternal", url: "https://example.com/" })); true"#)
                }
                Button("Navigate away") { run(#"location.href = "https://example.com/"; true"#) }
                Button("Next theme") { nextTheme() }
            }
            .buttonStyle(.bordered)
            .font(.system(size: 12))
            Text(readout)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(c.text2)
                .textSelection(.enabled)
                .lineLimit(8)
                .accessibilityLabel("Probe \(readout)")
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.bgElev)
        .task {
            while !Task.isCancelled {
                if let s = await probe.host?.evaluate(PluginTabProbe.readBack) { readout = s }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func run(_ script: String) {
        Task { _ = await probe.host?.evaluate(script) }
    }

    /// Steps the current appearance's theme through the registry (harness:theme to the page).
    private func nextTheme() {
        let appearance = app.resolvedTheme(systemDark: c.isDark).appearance
        let list = Themes.themes(for: appearance)
        let current = appearance == .dark ? app.prefs.darkTheme : app.prefs.lightTheme
        let i = list.firstIndex { $0.id == current } ?? -1
        let next = list[(i + 1) % list.count].id
        if appearance == .dark { app.setPref(\.darkTheme, next) } else { app.setPref(\.lightTheme, next) }
    }
}

extension EnvironmentValues {
    /// Set by BrowserPluginDebugScreen; PluginTabView injects its script and reports its host.
    @Entry var pluginTabProbe: PluginTabProbe?
}
#endif
