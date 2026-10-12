import HarnessKit
import SwiftUI
import UIKit
import WebKit

/// One CodeMirror editor in a WKWebView: the bundled editor.html (which runs editor/src/bridge.ts's
/// `mount`) and the native end of its bridge. The page document scrolls (not an inner scroller), so
/// the web view's own scroll view is what UIKit sees: a sheet drags down from its top and the
/// keyboard insets it natively.
///
///   host → page: `evaluateJavaScript(FileEditorCommand.script)`, once the page said `ready`
///   page → host: the page's `post` stringifies each event to the `editor` message handler
@MainActor
@Observable
final class EditorWebHost: NSObject {
    static let handlerName = "editor"

    /// The page mounted (and again after a reload): commands before it are dropped, since `open`
    /// carries everything the page needs.
    private(set) var ready = false

    /// The text of the first marked (linked) line once the page has scrolled to it. sim-check reads it
    /// through the editor's accessibility value, since a web view's page isn't in the AX tree.
    private(set) var revealedLine: String?

    @ObservationIgnored let webView: EditorWebView
    /// The page is (re)ready: send `open` or `diff` now.
    @ObservationIgnored var onReady: () -> Void = {}
    @ObservationIgnored var onEvent: (FileEditorEvent) -> Void = { _ in }
    @ObservationIgnored nonisolated(unsafe) private var keyboardObserver: NSObjectProtocol?

    override init() {
        let config = WKWebViewConfiguration()
        let content = WKUserContentController()
        config.userContentController = content
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = EditorWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.isOpaque = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        super.init()
        // The content controller retains its handlers; the proxy keeps that from retaining us.
        content.add(WeakEditorHandler(self), name: Self.handlerName)
        webView.navigationDelegate = self
        keyboardObserver = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.send(.scrollToCursor) }
        }
    }

    deinit {
        if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
    }

    /// Loads editor.html from the app bundle (once).
    func load() {
        guard webView.url == nil, let page = Bundle.main.url(forResource: "editor", withExtension: "html") else { return }
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    func setBackground(_ color: UIColor) {
        webView.backgroundColor = color
        webView.scrollView.backgroundColor = color
        webView.underPageBackgroundColor = color
    }

    func send(_ command: FileEditorCommand) {
        guard ready else { return }
        webView.evaluateJavaScript(command.script, completionHandler: nil)
    }

    /// Reads which line the page marked for a linked range, after it has had time to scroll there.
    func readRevealedLine() async {
        try? await Task.sleep(for: .milliseconds(500))
        revealedLine = await evaluate("(document.querySelector('.cm-revealed-line') || {}).textContent || ''")
    }

    func tearDown() {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
        webView.stopLoading()
    }

    /// Run a script in the page and return its result as a string (DEBUG probes).
    func evaluate(_ script: String) async -> String? {
        (try? await webView.evaluateJavaScript(script)).map { "\($0)" }
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let event = FileEditorEvent.decode(body: message.body) else { return }
        if event == .ready {
            ready = true
            onReady()
        }
        onEvent(event)
    }
}

extension EditorWebHost: WKNavigationDelegate {
    /// The page is local and has nothing to link to: no navigation but the first load.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url?.isFileURL == true ? .allow : .cancel
    }

    /// WebKit's content process died (memory pressure): reload the page; it says `ready` again and the
    /// owner reopens it with the unsaved contents.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        webView.reload()
    }
}

/// A web view that forwards Cmd+S (a hardware keyboard on iPad) to the host, whichever of the page
/// or UIKit sees the key first.
final class EditorWebView: WKWebView {
    var onSaveShortcut: () -> Void = {}

    override var keyCommands: [UIKeyCommand]? {
        let save = UIKeyCommand(input: "s", modifierFlags: .command, action: #selector(saveShortcut))
        save.wantsPriorityOverSystemBehavior = true
        return (super.keyCommands ?? []) + [save]
    }

    @objc private func saveShortcut() { onSaveShortcut() }
}

/// Forwards script messages to the host without the content controller retaining it.
private final class WeakEditorHandler: NSObject, WKScriptMessageHandler {
    weak var host: EditorWebHost?

    init(_ host: EditorWebHost) { self.host = host }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { host?.receive(message) }
    }
}

/// The host's web view in SwiftUI.
struct EditorWebViewRepresentable: UIViewRepresentable {
    let host: EditorWebHost

    func makeUIView(context: Context) -> WKWebView {
        host.load()
        return host.webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
