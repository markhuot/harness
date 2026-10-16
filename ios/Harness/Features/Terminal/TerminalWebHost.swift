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
        webView.onFocusChange = { [weak self] focused in MainActor.assumeIsolated { self?.editing = focused } }
        webView.onLayout = { [weak self] size in MainActor.assumeIsolated { self?.sizeChanged(size) } }
        // A keyboard change that came while the web view was out of a window (docked, switched away) was
        // recorded but not applied: apply what the keyboard is now as soon as the web view is back.
        webView.onWindowChange = { [weak self] in MainActor.assumeIsolated { self?.keyboardChanged(nil) } }
        // The keyboard covers the web view instead of resizing it; the page shrinks the terminal by `inset`,
        // so the rows it reports follow the keyboard.
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

    /// Points of the web view the keyboard and the key bar riding above it cover, as last told to the page.
    private(set) var keyboardInset: Double = 0
    /// The key bar's height; it sits below the web view and rides up over it with the keyboard.
    var barHeight: Double = 0 { didSet { if barHeight != oldValue { keyboardChanged(nil) } } }
    /// How far the keyboard pushes the key bar up from below the web view (0 with the keyboard down).
    private(set) var keyboardCover: Double = 0
    private var keyboard = TerminalKeyboardTracker()

    private func keyboardChanged(_ end: CGRect?) {
        keyboard.record(keyboardTop: end.map { Double($0.minY) })
        let frame = webView.convert(webView.bounds, to: nil)
        guard let cover = keyboard.cover(inWindow: webView.window != nil, webViewBottom: frame.maxY, barHeight: barHeight) else { return }
        keyboardCover = cover
        sendInset()
    }

    private func sendInset() {
        guard keyboardCover != keyboardInset else { return }
        keyboardInset = keyboardCover
        send(.inset(keyboardCover))
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

    /// The web view is the first responder: the keyboard (or, next to a hardware keyboard, its bar) is
    /// up, and `resignFocus` takes it down.
    private(set) var editing = false

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
    var onFocusChange: (Bool) -> Void = { _ in }
    var onWindowChange: () -> Void = {}

    /// No ‹ › ✓ form bar above the keyboard: a terminal has no fields to step through, and the key bar does its job.
    override var inputAccessoryView: UIView? { nil }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { onFocusChange(true) }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocusChange(false) }
        return resigned
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { onWindowChange() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // WebKit scrolls a focused field into view above the keyboard, and doesn't always scroll back
        // once it hides, which leaves the page shifted up with an empty band under it. The terminal
        // pans itself (bridge.ts `pan`), so the web view never scrolls.
        if scrollView.contentOffset != .zero { scrollView.contentOffset = .zero }
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
