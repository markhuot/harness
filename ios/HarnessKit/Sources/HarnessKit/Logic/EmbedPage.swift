import Foundation

// An embedded page's web view glue that isn't WebKit (DESIGN.md "Embedded pages"): the
// `harness-embed://<id>/<path>` URLs the app's WKURLSchemeHandler answers from the service's
// `GET /embeds/:id/*`, which navigations stay in the embed, what the sizing script may post, which
// response headers pass through to the page, and when an embed in a scrolling spec holds a live web
// view. Foundation only, so the app's delegates just forward to these.

public enum EmbedPage {
    /// The URL scheme the page loads from. The web view never sees the service's address or token.
    public static let scheme = "harness-embed"
    /// The script message handler the service's sizing script posts the page height to.
    public static let messageHandler = "harnessEmbed"

    /// An attachment id as the service mints them (and markdown's attachLine accepts).
    static func validId(_ id: String) -> Bool {
        guard let first = id.unicodeScalars.first, isAlnum(first) else { return false }
        return id.unicodeScalars.allSatisfy { isAlnum($0) || $0 == "." || $0 == "_" || $0 == "-" }
    }

    private static func isAlnum(_ s: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(s) || ("A"..."Z").contains(s) || ("0"..."9").contains(s)
    }

    /// The page's entry: `harness-embed://<id>/` (the service serves the manifest's entry for an empty path).
    public static func entryURL(_ id: String) -> URL? {
        validId(id) ? URL(string: "\(scheme)://\(id)/") : nil
    }

    /// The service path a `harness-embed://<id>/<path>` URL names: `/embeds/<id>/<path>`, the path
    /// kept percent-encoded as the page wrote it, its query and fragment dropped (the service serves
    /// files, by name). Nil for another scheme, an id the service never mints, or a `..` segment.
    public static func servicePath(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme,
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let id = c.host, validId(id) else { return nil }
        let path = c.percentEncodedPath
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        if segments.contains(where: { $0.removingPercentEncoding == ".." || $0.removingPercentEncoding == "." }) { return nil }
        let rel = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return "/embeds/\(id)/\(rel)"
    }

    /// What to do with a navigation in the embed of page `id`. The main frame stays on its own page:
    /// its own `harness-embed://<id>/` files (and about:blank) load, an http(s) or mailto link opens in
    /// the system, and anything else (another page's files, javascript:, a custom app scheme) is
    /// cancelled. A subframe (an iframe the page builds) may also load http(s), as a browser's would.
    public static func navigationPolicy(url: String, id: String, mainFrame: Bool) -> PluginHost.NavigationPolicy {
        let policy = PluginHost.navigationPolicy(url: url, serviceOrigin: "\(scheme)://\(id)")
        if !mainFrame, policy == .openExternally, !url.lowercased().hasPrefix("mailto:") { return .allow }
        if !mainFrame, url == "about:srcdoc" { return .allow }
        return policy
    }

    /// The height a `harnessEmbed` message reports: a number, and nothing else (a string, a
    /// boolean, an object are ignored). EmbedSize decides what to do with it.
    public static func reportedHeight(_ body: Any) -> Double? {
        guard let n = body as? NSNumber else { return nil }
        // JS true/false arrive as NSNumber too; they aren't heights.
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
        return n.doubleValue
    }

    /// The service response headers the page sees: its type and the range answer, nothing about the
    /// service (no cookies, no server). Keys as the service sent them, matched without case. The
    /// length isn't passed on: the body may have been decoded on the way, so the handler counts it.
    public static func pageHeaders(_ headers: [String: String]) -> [String: String] {
        let keep: Set = ["content-type", "content-range", "accept-ranges", "x-content-type-options", "access-control-allow-origin", "cache-control", "last-modified", "etag"]
        var out: [String: String] = [:]
        for (k, v) in headers where keep.contains(k.lowercased()) { out[k] = v }
        return out
    }

    /// How far off screen (in viewports) an embed loads its page, and how far it has to go before its
    /// web view is released. The gap between the two keeps one at the edge from flapping.
    public static let loadMargin: Double = 1
    public static let releaseMargin: Double = 3

    /// Whether an embed holds a live web view, given whether it does now (`live`), its top and bottom,
    /// and the visible part of the scroll view, all in one coordinate space. It loads once it comes
    /// within `loadMargin` viewports of the screen and is released past `releaseMargin`.
    public static func live(_ live: Bool, top: Double, bottom: Double, viewTop: Double, viewBottom: Double) -> Bool {
        let viewport = max(viewBottom - viewTop, 1)
        let gap = max(0, top - viewBottom, viewTop - bottom)
        return gap <= (live ? releaseMargin : loadMargin) * viewport
    }
}
