import HarnessKit
import SwiftUI
import UIKit
import WebKit

/// One embedded page's web view (DESIGN.md "Embedded pages"): a spec's `[caption](attachment:<id>)`
/// line whose attachment is a page. The page loads from `harness-embed://<id>/`, which
/// EmbedSchemeHandler answers from the service's `GET /embeds/<id>/*` with the paired connection's
/// token, so the web view never sees the token or the service's address. Its data store is
/// non-persistent (nothing it stores outlives the view), it has no native bridge, and the only
/// message it can send is its height (`harnessEmbed`, from the service's sizing script). Links and
/// popups leave for the system browser (EmbedPage.navigationPolicy); camera, microphone and motion
/// requests are denied. Modeled on PluginWebHost, without its bridge.
@MainActor @Observable final class EmbedWebHost: NSObject {
    let id: String
    @ObservationIgnored let webView: WKWebView
    /// The main frame failed to load (a transport error, or the service answered with an error).
    private(set) var failed = false
    /// Each height the page reports (EmbedPage.reportedHeight already applied).
    @ObservationIgnored var onHeight: (Double) -> Void = { _ in }
    @ObservationIgnored private let schemes: EmbedSchemeHandler

    init(id: String, client: HarnessClient) {
        self.id = id
        schemes = EmbedSchemeHandler(client: client)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(schemes, forURLScheme: EmbedPage.scheme)
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.dataDetectorTypes = []
        let content = WKUserContentController()
        config.userContentController = content
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Opaque, with no background color of ours: WebKit then draws the canvas by the page's own
        // color-scheme under the app's appearance (preferredColorScheme), dark for a page declaring
        // `color-scheme: light dark` in a dark app and white for one declaring nothing, whose black
        // text a transparent view would leave on the dark app.
        webView.isOpaque = true
        super.init()
        content.add(EmbedMessageHandler(self), name: EmbedPage.messageHandler)
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    func load() {
        guard webView.url == nil, let url = EmbedPage.entryURL(id) else {
            if EmbedPage.entryURL(id) == nil { failed = true }
            return
        }
        failed = false
        webView.load(URLRequest(url: url))
    }

    /// Stops the page and lets its web content process go.
    func tearDown() {
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: EmbedPage.messageHandler)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        // Only the page itself, not an iframe it builds, sizes the embed.
        guard message.frameInfo.isMainFrame, let h = EmbedPage.reportedHeight(message.body) else { return }
        onHeight(h)
    }

    private func decide(_ url: URL?, mainFrame: Bool) -> Bool {
        guard let url else { return false }
        switch EmbedPage.navigationPolicy(url: url.absoluteString, id: id, mainFrame: mainFrame) {
        case .allow: return true
        case .openExternally:
            UIApplication.shared.open(url)
            return false
        case .deny: return false
        }
    }
}

extension EmbedWebHost: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        // A download attribute or a file the page can't show isn't saved anywhere.
        if action.shouldPerformDownload { return .cancel }
        return decide(action.request.url, mainFrame: action.targetFrame?.isMainFrame ?? true) ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 { failed = true }
        return response.canShowMIMEType ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { failed = true }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { failed = true }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        failed = true
    }

    /// No new windows: a popup's URL goes through the policy (a web link opens in the system browser).
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url,
           EmbedPage.navigationPolicy(url: url.absoluteString, id: id, mainFrame: true) == .openExternally {
            UIApplication.shared.open(url)
        }
        return nil
    }

    /// No camera or microphone.
    func webView(
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType
    ) async -> WKPermissionDecision {
        .deny
    }

    /// No motion or orientation sensors.
    func webView(
        _ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo
    ) async -> WKPermissionDecision {
        .deny
    }

    /// No alert, confirm or prompt dialogs over the app.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {}

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        false
    }

    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo
    ) async -> String? {
        nil
    }
}

/// Forwards the sizing script's messages to the host without the content controller retaining it.
private final class EmbedMessageHandler: NSObject, WKScriptMessageHandler {
    weak var host: EmbedWebHost?

    init(_ host: EmbedWebHost) { self.host = host }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { host?.receive(message) }
    }
}

/// Answers `harness-embed://<id>/<path>` from the service's `/embeds/<id>/<path>` with the paired
/// connection's client (its token in the header, over whatever route the pairing uses, Tailscale
/// included). The status, content type and range answer pass through; nothing else about the service does.
@MainActor final class EmbedSchemeHandler: NSObject, WKURLSchemeHandler {
    private let client: HarnessClient
    /// Tasks WebKit hasn't stopped: calling a stopped task throws an Objective-C exception.
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(client: HarnessClient) { self.client = client }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        let request = urlSchemeTask.request
        guard let url = request.url, let path = EmbedPage.servicePath(url) else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let range = request.value(forHTTPHeaderField: "Range")
        let client = client
        running[key] = Task { [weak self] in
            let result: Result<HTTPResponse, Error>
            do { result = .success(try await client.embedFile(path, range: range)) } catch { result = .failure(error) }
            guard let self, self.running.removeValue(forKey: key) != nil, !Task.isCancelled else { return }
            switch result {
            case let .success(res):
                var headers = EmbedPage.pageHeaders(res.headers)
                headers["Content-Length"] = String(res.body.count)
                let response = HTTPURLResponse(url: url, statusCode: res.status, httpVersion: "HTTP/1.1", headerFields: headers)
                    ?? URLResponse(url: url, mimeType: nil, expectedContentLength: res.body.count, textEncodingName: nil)
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(res.body)
                urlSchemeTask.didFinish()
            case let .failure(error):
                urlSchemeTask.didFailWithError(error)
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }
}

/// The host's web view in SwiftUI. `interactive` false lets touches through to what's behind (the
/// spec's scroll view) until the embed is tapped.
struct EmbedWebViewRepresentable: UIViewRepresentable {
    let host: EmbedWebHost
    var interactive = true

    func makeUIView(context: Context) -> WKWebView {
        host.load()
        host.webView.isUserInteractionEnabled = interactive
        return host.webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        view.isUserInteractionEnabled = interactive
    }
}
