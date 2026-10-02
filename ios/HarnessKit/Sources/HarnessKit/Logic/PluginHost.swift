import Foundation

// WebView transport for the plugin host bridge (DESIGN.md "Plugins" → "Bridge"). The app hosts
// plugin tab UIs in a WKWebView and drives them with the same `PluginHostBridge` the desktop iframe
// uses; this file adapts the web view's channels to the bridge's `PluginFrame` / `HostMessageEvent`
// shapes. Foundation only, so `swift test` covers it.
//
//   host → page: webView.evaluateJavaScript(buildInjection(msg, serviceOrigin)), which calls
//                window.postMessage inside the page only if the page is still at serviceOrigin
//   page → host: the plugin SDK calls window.ReactNativeWebView.postMessage(JSON.stringify(msg))
//                (a historical name, from the 1.x React Native app's web view, that plugins
//                and the desktop still use; `nativeBridgeScript` defines it over a
//                WKScriptMessage handler) → messageEvent(data:url:source:) → bridge.onMessage
//
// The injected script is byte-for-byte what the frozen fixtures expect. JSON.stringify writes keys
// in insertion order, which a JSONValue doesn't have, so `jsonStringify` uses a canonical order
// (array-index keys numerically, then the rest by UTF-16 code units); JavaScript gives the same
// bytes for an object whose keys were inserted in that order. Key order never changes what the
// page gets.

public enum PluginHost {
    /// `JSON.stringify(value)`: the same escaping (`"` `\` and C0 controls only; `/`, U+2028/2029 and
    /// non-ASCII stay raw) and the same number formatting (`1e+21`, `-0` → `0`, non-finite → `null`).
    /// Object keys come out in the canonical order described above.
    public static func jsonStringify(_ value: JSONValue) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    /// JSON that is also a safe JS expression (JSON allows U+2028/U+2029 raw; older JS parsers don't).
    static func jsLiteral(_ value: JSONValue) -> String {
        var out = ""
        for c in jsonStringify(value).unicodeScalars {
            switch c {
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default: out.unicodeScalars.append(c)
            }
        }
        return out
    }

    /// A script for `evaluateJavaScript` that delivers `msg` as a window "message" event inside the
    /// page, but only when the page is still at `targetOrigin` (so the token never reaches a page
    /// that navigated away). Ends in `true;`, which the 1.x React Native app's web view required;
    /// kept so the bytes match the frozen fixtures (WKWebView just returns true).
    public static func buildInjection(_ msg: JSONValue, targetOrigin: String) -> String {
        let origin = jsLiteral(.string(targetOrigin))
        return "(function(){ if (location.origin !== \(origin)) return; window.postMessage(\(jsLiteral(msg)), \(origin)); })(); true;"
    }

    /// `buildInjection` for a bridge message (encoded the way the service shapes it).
    public static func buildInjection(_ msg: PluginHostMessage, targetOrigin: String) -> String {
        buildInjection(json(msg), targetOrigin: targetOrigin)
    }

    /// Adapt a WKScriptMessage (its body string and the sending frame's URL) into what
    /// `bridge.onMessage` reads. `source` should be the frame the bridge's `frame()` returns (the
    /// bridge checks identity). Returns nil when the data isn't JSON or the URL can't be parsed.
    public static func messageEvent(data: String, url: String, source: AnyObject?) -> PluginBridge.HostMessageEvent? {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(data.utf8)),
              let origin = PluginBridge.origin(of: url)
        else { return nil }
        return PluginBridge.HostMessageEvent(data: value, origin: origin, source: source)
    }

    /// A user script (inject at document start, main frame only) that gives the page the
    /// `window.ReactNativeWebView.postMessage(string)` the plugin SDK looks for, forwarding to the
    /// WKScriptMessageHandler registered as `handler`. (react-native-webview provided it in the
    /// 1.x app.)
    public static func nativeBridgeScript(handler: String) -> String {
        let name = jsLiteral(.string(handler))
        return "window.ReactNativeWebView = { postMessage: function (data) { window.webkit.messageHandlers[\(name)].postMessage(String(data)); } }; true;"
    }

    /// A `PluginFrame` whose postMessage injects the message into the web view.
    public final class WebViewFrame: PluginFrame {
        private let inject: (String) -> Void

        /// `inject` runs a script in the page (`webView.evaluateJavaScript`).
        public init(inject: @escaping (String) -> Void) {
            self.inject = inject
        }

        public func postMessage(_ message: PluginHostMessage, targetOrigin: String) {
            inject(PluginHost.buildInjection(message, targetOrigin: targetOrigin))
        }
    }

    private static func json(_ msg: PluginHostMessage) -> JSONValue {
        // Encoding our own Codable model to JSON and back can't fail.
        try! JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(msg))
    }

    private static func write(_ value: JSONValue, into out: inout String) {
        switch value {
        case .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .number(n): out += n.isFinite ? JSCompat.string(n) : "null"
        case let .string(s): quote(s, into: &out)
        case let .array(a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                write(v, into: &out)
            }
            out += "]"
        case let .object(o):
            out += "{"
            for (i, k) in orderedKeys(o.keys).enumerated() {
                if i > 0 { out += "," }
                quote(k, into: &out)
                out += ":"
                write(o[k]!, into: &out)
            }
            out += "}"
        }
    }

    /// JS own-property order for an object whose keys were inserted sorted: array indices
    /// (canonical integers below 2³²−1) ascending, then the rest by UTF-16 code units.
    private static func orderedKeys(_ keys: Dictionary<String, JSONValue>.Keys) -> [String] {
        var indices: [(UInt32, String)] = []
        var names: [String] = []
        for k in keys {
            if let i = arrayIndex(k) { indices.append((i, k)) } else { names.append(k) }
        }
        indices.sort { $0.0 < $1.0 }
        names.sort { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        return indices.map(\.1) + names
    }

    private static func arrayIndex(_ k: String) -> UInt32? {
        let u = Array(k.utf8)
        guard !u.isEmpty, u.count <= 10, u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), u == [0x30] || u[0] != 0x30 else { return nil }
        guard let n = UInt64(k), n < 4_294_967_295 else { return nil }
        return UInt32(n)
    }

    private static func quote(_ s: String, into out: inout String) {
        out += "\""
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if c.value < 0x20 {
                    let hex = String(c.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(c)
                }
            }
        }
        out += "\""
    }
}
