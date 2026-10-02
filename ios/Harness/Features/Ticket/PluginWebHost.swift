import HarnessKit
import SwiftUI
import UIKit
import WebKit

/// One plugin tab's WKWebView and its host bridge (screens/PluginTab.tsx PluginFrame + lib/pluginHost).
/// The page is the plugin's UI served by the service; the bridge rules are the desktop's
/// (PluginHostBridge), carried over the web view:
///
///   host → page: `evaluateJavaScript(PluginHost.buildInjection(msg, serviceOrigin))`, which posts
///                inside the page only while it's still at the service origin
///   page → host: the plugin SDK's `window.ReactNativeWebView.postMessage(json)`, defined by a
///                document-start user script over the `harness` WKScriptMessageHandler, so existing
///                plugin UIs work unchanged
@MainActor
@Observable
final class PluginWebHost: NSObject {
    static let handlerName = "harness"

    /// harness:ready arrived, or 1.5 s passed after the page loaded (plugins without the SDK).
    private(set) var ready = false

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored let src: URL?
    @ObservationIgnored private(set) var bridge: PluginHostBridge?
    @ObservationIgnored private var frame: PluginHost.WebViewFrame!
    @ObservationIgnored private var theme: PluginBridge.HostTheme
    @ObservationIgnored private var readyTimer: Task<Void, Never>?
    @ObservationIgnored var onNavigate: (String) -> Void = { _ in }
    @ObservationIgnored var onOpenExternal: (URL) -> Void = { _ in }

    /// - Parameter extraScripts: more document-start scripts (the DEBUG screen's message probe).
    init(baseUrl: String, token: String, ticketKey: String, tab: PluginTab, theme: PluginBridge.HostTheme, extraScripts: [String] = []) {
        self.theme = theme
        src = URL(string: PluginBridge.pluginUiUrl(baseUrl: baseUrl, pluginId: tab.pluginId, tabId: tab.id))

        let config = WKWebViewConfiguration()
        let content = WKUserContentController()
        for source in [PluginHost.nativeBridgeScript(handler: Self.handlerName)] + extraScripts {
            content.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        config.userContentController = content
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        super.init()

        frame = PluginHost.WebViewFrame { [weak webView] script in
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }
        bridge = PluginHostBridge(.init(
            baseUrl: baseUrl, token: token, ticketKey: ticketKey, tabId: tab.id,
            frame: { [weak self] in self?.frame },
            theme: { [weak self] in self?.theme ?? theme },
            onNavigate: { [weak self] key in self?.onNavigate(key) },
            onOpenExternal: { [weak self] url in if let u = URL(string: url) { self?.onOpenExternal(u) } },
            onReady: { [weak self] in self?.ready = true }))
        // The content controller retains its handlers; the proxy keeps that from retaining us.
        content.add(WeakScriptHandler(self), name: Self.handlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    /// Load the plugin's page (once).
    func load() {
        guard webView.url == nil, let src else { return }
        webView.load(URLRequest(url: src))
    }

    func setBackground(_ color: UIColor) {
        webView.backgroundColor = color
        webView.scrollView.backgroundColor = color
        webView.underPageBackgroundColor = color
    }

    /// The app theme changed: harness:theme. Unchanged themes aren't re-sent (iOS flips the
    /// appearance while it snapshots a backgrounded app, and init already carried the first one).
    func sendTheme(_ t: PluginBridge.HostTheme) {
        guard t != theme else { return }
        theme = t
        bridge?.sendTheme(t)
    }

    /// The ticket changed: harness:ticket.
    func sendTicket(_ ticket: Ticket) {
        bridge?.sendTicket(ticket)
    }

    func tearDown() {
        readyTimer?.cancel()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
        webView.stopLoading()
    }

    /// Run a script in the page and return its result as a string (DEBUG probes).
    func evaluate(_ script: String) async -> String? {
        (try? await webView.evaluateJavaScript(script)).map { "\($0)" }
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard let e = PluginHost.scriptMessageEvent(
            body: message.body, frameURL: message.frameInfo.request.url, isMainFrame: message.frameInfo.isMainFrame, source: frame)
        else { return }
        bridge?.onMessage(e)
    }

    private func decide(_ url: URL?) -> Bool {
        guard let bridge, let url else { return false }
        switch PluginHost.navigationPolicy(url: url.absoluteString, serviceOrigin: bridge.serviceOrigin) {
        case .allow: return true
        case .openExternally:
            onOpenExternal(url)
            return false
        case .deny: return false
        }
    }
}

extension PluginWebHost: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        decide(action.request.url) ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        bridge?.onLoad()
        readyTimer?.cancel()
        readyTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard let self, !Task.isCancelled else { return }
            self.ready = true
        }
    }

    /// No new windows: a target=_blank link loads in place (react-native-webview without
    /// multiple windows), where the navigation policy applies.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if action.targetFrame == nil, decide(action.request.url) { webView.load(action.request) }
        return nil
    }
}

/// Forwards script messages to the host without the content controller retaining it.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var host: PluginWebHost?

    init(_ host: PluginWebHost) { self.host = host }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { host?.receive(message) }
    }
}

/// The host's web view in SwiftUI.
struct PluginWebViewRepresentable: UIViewRepresentable {
    let host: PluginWebHost

    func makeUIView(context: Context) -> WKWebView {
        host.load()
        return host.webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
