import HarnessKit
import SwiftUI

/// A plugin's ticket tab (screens/PluginTab.tsx PluginFrame): the plugin's UI page from the service
/// in a WKWebView, driven by the shared host bridge (PluginWebHost). It gets the token, ticket and
/// the full theme in harness:init, harness:theme when the theme changes and harness:ticket when the
/// ticket does; harness:navigate pushes the ticket and harness:openExternal opens the URL outside
/// the app. Hidden behind a spinner until the plugin says it's ready (or 1.5 s after load).
struct PluginTabView: View {
    let ticket: Ticket
    let tab: PluginTab

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @Environment(\.openURL) private var openURL
    @State private var host: PluginWebHost?
    #if DEBUG
    @Environment(\.pluginTabProbe) private var probe
    #endif

    /// What the bridge is built for (RN's useMemo deps: client, ticket key, tab).
    private struct HostKey: Hashable {
        let baseUrl: String
        let token: String
        let ticketKey: String
        let pluginId: String
        let tabId: String
    }

    private var client: HarnessClient? { store.client as? HarnessClient }
    private var hostKey: HostKey? {
        client.map { HostKey(baseUrl: $0.baseUrl, token: $0.token, ticketKey: ticket.key, pluginId: tab.pluginId, tabId: tab.id) }
    }
    /// Plugins get the full theme (id, tokens, syntax theme) next to the old light/dark value.
    private var theme: PluginBridge.HostTheme { .full(PluginThemeInfo(c.theme)) }

    var body: some View {
        ZStack {
            c.bg
            if let host {
                PluginWebViewRepresentable(host: host)
                    .opacity(host.ready ? 1 : 0)
                    .accessibilityHidden(!host.ready)
                if !host.ready {
                    Spinner().accessibilityLabel("In progress")
                }
            }
        }
        .task(id: hostKey) { makeHost() }
        .onChange(of: PluginThemeInfo(c.theme)) { _, info in
            host?.setBackground(UIColor(c.bg))
            host?.sendTheme(.full(info))
        }
        .onChange(of: ticket) { _, t in host?.sendTicket(t) }
    }

    private func makeHost() {
        guard let client else { return }
        host?.tearDown()
        #if DEBUG
        let extra = probe.map { [$0.script] } ?? []
        #else
        let extra: [String] = []
        #endif
        let h = PluginWebHost(baseUrl: client.baseUrl, token: client.token, ticketKey: ticket.key, tab: tab, theme: theme, extraScripts: extra)
        #if DEBUG
        probe?.host = h
        #endif
        h.setBackground(UIColor(c.bg))
        h.onNavigate = { key in router.push(.ticket(key: key, tab: nil)) }
        h.onOpenExternal = { url in openURL(url) }
        host = h
    }
}
