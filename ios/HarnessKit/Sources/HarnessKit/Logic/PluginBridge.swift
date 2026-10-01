import Foundation

// Port of shared/src/state/pluginBridge.ts.
//
// Host side of the plugin bridge (DESIGN.md "Plugins"). Pure logic, no UI/WebKit, shared by every
// host, which all follow the same rules:
//   - the token only ever goes to the service origin (postMessage targetOrigin = serviceOrigin)
//   - only messages from our own frame, at the service origin, are accepted
//   - openExternal is limited to http(s)/mailto; navigate to well-formed ticket keys
//
// Transport seam: the bridge never touches a web view. It posts through `PluginFrame` (the TS
// `FrameWindow`), which the WKWebView host implements, e.g. with `PluginHost.WebViewFrame`, whose
// `postMessage` runs `PluginHost.buildInjection` through `evaluateJavaScript`. Page → host messages
// arrive as `PluginBridge.HostMessageEvent`s (see `PluginHost.messageEvent(data:url:source:)`).

/// What the bridge posts through: the plugin frame (TS `FrameWindow`). The bridge compares the
/// object identity of `HostMessageEvent.source` with `frame()`, so a host passes the same instance
/// as the source of the frame's messages.
public protocol PluginFrame: AnyObject {
    func postMessage(_ message: PluginHostMessage, targetOrigin: String)
}

public enum PluginBridge {
    /// What a host knows about its theme: just the appearance, or the full theme (tokens and all).
    public enum HostTheme: Sendable, Equatable {
        case appearance(Appearance)
        case full(PluginThemeInfo)
    }

    /// What the bridge reads from a message event (a WebView message adapted to it).
    public struct HostMessageEvent {
        public var data: JSONValue
        public var origin: String
        public var source: AnyObject?

        public init(data: JSONValue, origin: String, source: AnyObject?) {
            self.data = data
            self.origin = origin
            self.source = source
        }
    }

    /// The theme fields of harness:init / harness:theme: the old `theme` plus, when known, the full theme.
    public static func themeFields(_ t: HostTheme) -> (theme: Appearance, fields: PluginThemeFields) {
        switch t {
        case let .appearance(a):
            return (a, PluginThemeFields())
        case let .full(info):
            let appearance = Appearance(rawValue: info.appearance.rawValue)
            let tokens = Dictionary(uniqueKeysWithValues: ThemeToken.allCases.map { ($0.rawValue, info.tokens[keyPath: $0.keyPath]) })
            return (
                appearance,
                PluginThemeFields(
                    appearance: appearance, themeId: info.themeId, themeName: info.themeName,
                    syntaxTheme: info.syntaxTheme.map(Patch.value) ?? .null, tokens: tokens
                )
            )
        }
    }

    public static func pluginUiUrl(baseUrl: String, pluginId: String, tabId: String) -> String {
        "\(stripTrailingSlash(baseUrl))/plugins/\(URIComponent.encode(pluginId))/ui/index.html?tab=\(URIComponent.encode(tabId))"
    }

    /// `new URL(url).origin`, or nil where `new URL` throws. Opaque origins (file:, mailto:,
    /// about:, any non-special scheme) are "null", as in JS.
    ///
    /// Covers what a service base URL or page URL looks like: scheme and host lower-cased, default
    /// ports dropped, userinfo, path, query and fragment ignored. Not a full WHATWG parser: IPv4
    /// shorthands (`0x7f.1`), IDNA (non-ASCII hosts) and IPv6 re-compression are left as written.
    public static func origin(of url: String) -> String? {
        var scalars = Array(url.unicodeScalars)
        // Strip leading/trailing C0 controls and spaces, drop tabs and newlines anywhere.
        while let f = scalars.first, f.value <= 0x20 { scalars.removeFirst() }
        while let l = scalars.last, l.value <= 0x20 { scalars.removeLast() }
        scalars.removeAll { $0 == "\t" || $0 == "\n" || $0 == "\r" }

        guard let colon = scalars.firstIndex(of: ":"), colon > 0, isAlpha(scalars[0]),
              scalars[1..<colon].allSatisfy({ isAlpha($0) || isDigit($0) || $0 == "+" || $0 == "-" || $0 == "." })
        else { return nil }
        let scheme = String(String.UnicodeScalarView(scalars[..<colon])).lowercased()
        let defaultPort: Int?
        switch scheme {
        case "http", "ws": defaultPort = 80
        case "https", "wss": defaultPort = 443
        case "ftp": defaultPort = 21
        case "file": return "null"
        default: return "null"
        }

        var rest = scalars[(colon + 1)...]
        while let f = rest.first, f == "/" || f == "\\" { rest.removeFirst() }
        let authority = rest.prefix { !["/", "\\", "?", "#"].contains($0) }
        var hostPort = authority[...]
        if let at = authority.lastIndex(of: "@") { hostPort = authority[authority.index(after: at)...] }

        var host: ArraySlice<Unicode.Scalar>
        var portPart: ArraySlice<Unicode.Scalar>?
        if hostPort.first == "[" {
            guard let close = hostPort.firstIndex(of: "]") else { return nil }
            host = hostPort[hostPort.startIndex...close]
            let after = hostPort[hostPort.index(after: close)...]
            if let f = after.first {
                guard f == ":" else { return nil }
                portPart = after.dropFirst()
            }
        } else if let c = hostPort.firstIndex(of: ":") {
            host = hostPort[..<c]
            portPart = hostPort[hostPort.index(after: c)...]
        } else {
            host = hostPort
        }
        guard !host.isEmpty else { return nil }
        let forbidden: Set<Unicode.Scalar> = [" ", "<", ">", "^", "|", "%", "@", "[", "]", "\\", "/", "?", "#"]
        if host.first != "[", host.contains(where: { forbidden.contains($0) || $0.value < 0x20 || $0.value == 0x7F }) { return nil }
        let hostString = String(String.UnicodeScalarView(host)).lowercased()

        var port: Int?
        if let portPart, !portPart.isEmpty {
            guard portPart.allSatisfy(isDigit) else { return nil }
            let digits = portPart.drop { $0 == "0" }
            guard digits.count <= 5, let n = digits.isEmpty ? 0 : Int(String(String.UnicodeScalarView(digits))), n <= 65535 else { return nil }
            port = n
        }
        if let p = port, p != defaultPort { return "\(scheme)://\(hostString):\(p)" }
        return "\(scheme)://\(hostString)"
    }

    static func stripTrailingSlash(_ s: String) -> String {
        s.hasSuffix("/") ? String(s.dropLast()) : s
    }
}

/// The host side of one plugin tab's bridge (`createPluginHostBridge`). Not thread-safe: drive it
/// from the main actor, like the web view it talks to.
public final class PluginHostBridge {
    public struct Options {
        /// Service base URL, e.g. http://127.0.0.1:7717
        public var baseUrl: String
        public var token: String
        public var ticketKey: String
        public var tabId: String
        /// The frame's current window (nil before it exists)
        public var frame: () -> (any PluginFrame)?
        /// The current theme; `.full` also sends themeId, tokens and syntaxTheme
        public var theme: () -> PluginBridge.HostTheme
        public var onNavigate: (String) -> Void
        public var onOpenExternal: (String) -> Void
        /// First harness:ready from the frame (the plugin connected)
        public var onReady: (() -> Void)?

        public init(
            baseUrl: String, token: String, ticketKey: String, tabId: String, frame: @escaping () -> (any PluginFrame)?,
            theme: @escaping () -> PluginBridge.HostTheme, onNavigate: @escaping (String) -> Void,
            onOpenExternal: @escaping (String) -> Void, onReady: (() -> Void)? = nil
        ) {
            self.baseUrl = baseUrl
            self.token = token
            self.ticketKey = ticketKey
            self.tabId = tabId
            self.frame = frame
            self.theme = theme
            self.onNavigate = onNavigate
            self.onOpenExternal = onOpenExternal
            self.onReady = onReady
        }
    }

    public let serviceOrigin: String
    private let opts: Options
    private var ready = false

    /// nil where the TS throws (`new URL(baseUrl)` fails).
    public init?(_ options: Options) {
        guard let origin = PluginBridge.origin(of: options.baseUrl) else { return nil }
        serviceOrigin = origin
        opts = options
    }

    private func post(_ msg: PluginHostMessage) {
        opts.frame()?.postMessage(msg, targetOrigin: serviceOrigin)
    }

    private func sendInit() {
        let (theme, fields) = PluginBridge.themeFields(opts.theme())
        let payload = PluginHostMessage.Init(
            baseUrl: PluginBridge.stripTrailingSlash(opts.baseUrl), token: opts.token, ticketKey: opts.ticketKey, tabId: opts.tabId, theme: theme
        )
        post(.initialize(payload, fields))
    }

    /// Frame load event: offer init right away (plugins not using the SDK never send ready).
    public func onLoad() {
        sendInit()
    }

    /// A message from the page. Returns true when the message was accepted.
    @discardableResult
    public func onMessage(_ e: PluginBridge.HostMessageEvent) -> Bool {
        guard let frame = opts.frame(), let source = e.source, source === frame, e.origin == serviceOrigin else { return false }
        // `!msg || typeof msg !== "object"`: arrays pass this check in JS but have no `type`.
        guard case .object = e.data, case let .string(type)? = e.data["type"] else { return false }
        switch type {
        case "harness:ready":
            sendInit()
            if !ready {
                ready = true
                opts.onReady?()
            }
            return true
        case "harness:openExternal":
            guard case let .string(url)? = e.data["url"], isExternal(url) else { return false }
            opts.onOpenExternal(url)
            return true
        case "harness:navigate":
            guard case let .string(key)? = e.data["ticketKey"], isKey(key) else { return false }
            opts.onNavigate(key)
            return true
        default:
            return false
        }
    }

    public func sendTheme(_ theme: PluginBridge.HostTheme) {
        let (t, fields) = PluginBridge.themeFields(theme)
        post(.theme(t, fields))
    }

    public func sendTicket(_ ticket: Ticket) {
        if ticket.key == opts.ticketKey { post(.ticket(ticket)) }
    }
}

private func isAlpha(_ s: Unicode.Scalar) -> Bool { ("a"..."z").contains(s) || ("A"..."Z").contains(s) }
private func isDigit(_ s: Unicode.Scalar) -> Bool { ("0"..."9").contains(s) }
private func isUpper(_ s: Unicode.Scalar) -> Bool { ("A"..."Z").contains(s) }

/// `KEY = /^[A-Z][A-Z0-9_]*-\d+$/` (ASCII only; JS `$` without `m` doesn't match before a trailing newline).
private func isKey(_ key: String) -> Bool {
    let s = Array(key.unicodeScalars)
    guard let first = s.first, isUpper(first), let dash = s.lastIndex(of: "-") else { return false }
    let prefix = s[1..<dash]
    let digits = s[(dash + 1)...]
    return prefix.allSatisfy { isUpper($0) || isDigit($0) || $0 == "_" } && !digits.isEmpty && digits.allSatisfy(isDigit)
}

/// `EXTERNAL = /^(https?:\/\/|mailto:)/i`. Without `u`, `i` folds ASCII only (no ſ → s).
private func isExternal(_ url: String) -> Bool {
    let lower = url.unicodeScalars.prefix(8).map { s in isUpper(s) ? Unicode.Scalar(s.value + 32)! : s }
    return ["http://", "https://", "mailto:"].contains { lower.starts(with: $0.unicodeScalars) }
}
