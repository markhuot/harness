import HarnessKit
import SwiftUI
import UIKit
import WebKit

/// One terminal in a WKWebView: the bundled terminal.html (which runs terminal/src/bridge.ts's `mount`,
/// ghostty-web drawn on a canvas) and the native end of its bridge (HarnessKit's TerminalBridge.swift).
/// The socket stays in Swift (BoardStore → HarnessSocket); the page only draws and reports.
///
///   host → page: `evaluateJavaScript(TerminalCommand.script)`, once the page said `ready`
///   page → host: the page's `post` stringifies each event to the `terminal` message handler
@MainActor
@Observable
final class TerminalWebHost: NSObject {
    static let handlerName = "terminal"

    /// The page mounted (and again after a reload): commands before it are dropped, since `open`
    /// carries everything the page needs.
    private(set) var ready = false

    @ObservationIgnored let webView: TerminalWebView
    /// The page is (re)ready: send `open` now.
    @ObservationIgnored var onReady: () -> Void = {}
    @ObservationIgnored var onEvent: (TerminalEvent) -> Void = { _ in }
    @ObservationIgnored nonisolated(unsafe) private var keyboardObserver: NSObjectProtocol?

    override init() {
        let config = WKWebViewConfiguration()
        let content = WKUserContentController()
        config.userContentController = content
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = TerminalWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.isOpaque = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        super.init()
        #if SIM_CHECK
        DebugProbe.shared.register(self)
        #endif
        // The content controller retains its handlers; the proxy keeps that from retaining us.
        content.add(WeakTerminalHandler(self), name: Self.handlerName)
        webView.navigationDelegate = self
        webView.onLayout = { [weak self] size in MainActor.assumeIsolated { self?.sizeChanged(size) } }
        // The keyboard covers the web view instead of resizing it, so the rows the page reports never
        // change with it; the page pans to keep the cursor visible above `inset`.
        keyboardObserver = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
        ) { [weak self] note in
            let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
            MainActor.assumeIsolated { self?.keyboardChanged(end) }
        }
    }

    deinit {
        if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
    }

    /// Points of the web view the keyboard covers, as last told to the page.
    private(set) var keyboardInset: Double = 0
    /// The accessory bar sits above the keyboard, so it covers the web view too.
    var accessoryHeight: Double = 0 { didSet { if accessoryHeight != oldValue { sendInset() } } }
    /// How far the keyboard covers the web view; the accessory bar rides above it.
    private(set) var keyboardCover: Double = 0

    private func keyboardChanged(_ end: CGRect?) {
        guard webView.window != nil, let end else { return }
        let frame = webView.convert(webView.bounds, to: nil)
        keyboardCover = max(0, frame.maxY - end.minY)
        sendInset()
    }

    private func sendInset() {
        let inset = keyboardCover > 0 ? keyboardCover + accessoryHeight : accessoryHeight
        guard inset != keyboardInset else { return }
        keyboardInset = inset
        send(.inset(inset))
    }

    private var lastSize = CGSize.zero

    /// Tells the page its size (once it's ready, and whenever it changes). The keyboard's accessory
    /// and the home indicator's inset shave a few points off the web view as typing starts, and the
    /// rows the shell is given must not follow: a shrink that small keeps the height it had.
    private func sizeChanged(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        var next = size
        if next.width == lastSize.width, TerminalViewportRules.ignoresShrink(from: lastSize.height, to: next.height) { next.height = lastSize.height }
        guard next != lastSize else { return }
        lastSize = next
        send(.frame(width: next.width, height: next.height))
    }

    /// Loads terminal.html from the app bundle (once).
    func load() {
        guard webView.url == nil, let page = Bundle.main.url(forResource: "terminal", withExtension: "html") else { return }
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    func setBackground(_ color: UIColor) {
        webView.backgroundColor = color
        webView.scrollView.backgroundColor = color
        webView.underPageBackgroundColor = color
    }

    func send(_ command: TerminalCommand) {
        guard ready else { return }
        webView.evaluateJavaScript(command.script, completionHandler: nil)
    }

    /// Takes the keyboard down.
    func resignFocus() { webView.endEditing(true) }

    /// The terminal's state as the page reports it (the debug state probe); nil while none is open.
    func probe() async -> DebugState.TerminalState? {
        guard ready, let json = await evaluate("JSON.stringify(window.harnessTerminal ? window.harnessTerminal.probe() : null)"),
              let data = json.data(using: .utf8) else { return nil }
        guard var state = try? JSONDecoder().decode(DebugState.TerminalState.self, from: data) else { return nil }
        state.webView = .init(width: Double(webView.bounds.width), height: Double(webView.bounds.height))
        return state
    }

    /// Run a script in the page and return its result as a string (DEBUG probes).
    func evaluate(_ script: String) async -> String? {
        (try? await webView.evaluateJavaScript(script)).map { "\($0)" }
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let event = TerminalEvent.decode(body: message.body) else { return }
        if event == .ready {
            ready = true
            lastSize = .zero
            sizeChanged(webView.bounds.size)
            onReady()
        }
        onEvent(event)
    }
}

extension TerminalWebHost: WKNavigationDelegate {
    /// The page is local and has nothing to link to: no navigation but the first load.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url?.isFileURL == true ? .allow : .cancel
    }

    /// WebKit's content process died (memory pressure): reload the page; it says `ready` again and the
    /// owner opens the terminal again, which asks the service for a fresh snapshot.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        webView.reload()
    }
}

/// A web view that reports its size as it lays out, so the page can be exactly that big.
final class TerminalWebView: WKWebView {
    var onLayout: (CGSize) -> Void = { _ in }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout(bounds.size)
    }
}

/// Forwards script messages to the host without the content controller retaining it.
private final class WeakTerminalHandler: NSObject, WKScriptMessageHandler {
    weak var host: TerminalWebHost?

    init(_ host: TerminalWebHost) { self.host = host }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { host?.receive(message) }
    }
}

/// The host's web view in SwiftUI.
struct TerminalWebViewRepresentable: UIViewRepresentable {
    let host: TerminalWebHost

    func makeUIView(context: Context) -> WKWebView {
        host.load()
        return host.webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
