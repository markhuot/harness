import Foundation

// The WKWebView glue rules of mobile/src/screens/PluginTab.tsx that aren't in pluginHost.ts: which
// navigations load inside a plugin tab, and which script messages reach the bridge. Foundation
// only, so the app's WKNavigationDelegate / WKScriptMessageHandler just forward to these.

extension PluginHost {
    /// What to do with a navigation inside a plugin tab.
    public enum NavigationPolicy: Sendable, Equatable {
        /// Load it in the tab: the service origin, or about:blank.
        case allow
        /// Cancel it and open the URL in the system (Safari, Mail): an http(s) or mailto link.
        case openExternally
        /// Cancel it (any other scheme).
        case deny
    }

    /// `onShouldStartLoadWithRequest`: only the service origin may load in the tab; anything else
    /// that looks like a link opens outside the app. String prefix checks, as in the TS.
    public static func navigationPolicy(url: String, serviceOrigin: String) -> NavigationPolicy {
        if url.hasPrefix(serviceOrigin + "/") || url == serviceOrigin || url == "about:blank" { return .allow }
        // /^(https?:|mailto:)/i (ASCII folding only)
        let lower = String(String.UnicodeScalarView(url.unicodeScalars.prefix(7).map { s in
            ("A"..."Z").contains(s) ? Unicode.Scalar(s.value + 32)! : s
        }))
        if lower.hasPrefix("http:") || lower.hasPrefix("https:") || lower.hasPrefix("mailto:") { return .openExternally }
        return .deny
    }

    /// A WKScriptMessage from the `nativeBridgeScript` handler → what `bridge.onMessage` reads.
    /// react-native-webview delivers only the main frame's messages (its script is main-frame
    /// only), so a subframe's are dropped, as is a body that isn't the string the script sends.
    public static func scriptMessageEvent(body: Any, frameURL: URL?, isMainFrame: Bool, source: AnyObject?) -> PluginBridge.HostMessageEvent? {
        guard isMainFrame, let data = body as? String, let url = frameURL?.absoluteString else { return nil }
        return messageEvent(data: data, url: url, source: source)
    }
}
