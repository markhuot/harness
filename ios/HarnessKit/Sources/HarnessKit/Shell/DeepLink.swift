import Foundation

// The app's navigation vocabulary and the harness:// links that reach it. ios/Tools/sim-check.ts
// drives every screen through them. Parsing lives here
// so it's tested on the host; the app's Router (Router.swift) applies a DeepLink.

/// The shell's sections, picked in the Projects sidebar. Each keeps its own NavigationStack.
public enum AppTab: String, Codable, Hashable, Sendable, CaseIterable {
    case board, inbox, settings
}

/// A screen pushed onto a tab's NavigationStack. RN pushes these on the root stack above the
/// tabs; here they're pushed on the selected tab's stack.
public enum Route: Hashable, Sendable {
    /// harness://ticket/<key>?tab=…  `tab` is nil when the link has none (TicketDetail picks).
    case ticket(key: String, tab: TicketTab?)
    /// harness://inbox/<sessionId>
    case triage(sessionId: String)
    /// harness://file/<path>?ticket=|project=#Lx-Ly (FileViewer.fileRoute(forURL:))
    case file(FileRouteParams)
    /// harness://project/<id>
    case project(id: String)
    /// harness://driver/<id>: one driver's settings
    case driver(id: String)
    /// harness://prompts
    case prompts
    /// harness://prompt/<id>
    case prompt(id: String)
}

/// A modal sheet (RN `presentation: "modal" | "formSheet"`).
public enum SheetRoute: Hashable, Sendable, Identifiable {
    /// Projects, the sidebar (formSheet, medium/large).
    case projects
    /// New session, optionally for a project or resuming a planning ticket's draft.
    case newSession(projectId: String?, key: String?)
    /// The watcher form; nil id is a new watcher.
    case watcher(id: String?)
    /// Connect to a Mac (manual entry, saved Macs, Scan).
    case connect
    /// harness://pair?url=…&token=… (the raw, already-decoded params; PairScreen validates them).
    case pair(url: String?, token: String?)

    public var id: Self { self }
}

/// A full-screen cover (RN `presentation: "fullScreenModal"`).
public enum CoverRoute: Hashable, Sendable, Identifiable {
    /// The QR scanner.
    case scan

    public var id: Self { self }
}

/// What a harness:// URL asks for.
public enum DeepLink: Equatable, Sendable {
    /// A section: dismisses modals and pops the section to its root. `themes` carries the valid theme
    /// picks of a settings link (harness://settings?darkTheme=…), nil when it has none.
    case tab(AppTab, themes: ThemePicker.ThemePrefsPatch? = nil)
    /// A screen pushed on the selected tab (modals are dismissed first).
    case push(Route)
    case sheet(SheetRoute)
    case cover(CoverRoute)

    public static let scheme = "harness"

    /// harness://… → what it opens; nil for anything the app doesn't route (another scheme, an
    /// unknown host, a ticket link without a key).
    public static func parse(_ url: URL) -> DeepLink? {
        parse(url.absoluteString)
    }

    public static func parse(_ raw: String) -> DeepLink? {
        let s = raw.trimmingJSWhitespace()
        let prefix = "\(scheme)://"
        guard s.count >= prefix.count, s.prefix(prefix.count).lowercased() == prefix else { return nil }
        // harness://file/… keeps its fragment (the line anchor) and its own percent-encoding rules.
        if let file = FileViewer.fileRoute(forURL: s) { return .push(.file(file)) }

        var rest = Substring(s.dropFirst(prefix.count))
        if let hash = rest.firstIndex(of: "#") { rest = rest[..<hash] }
        var query: [URLQueryItem] = []
        if let q = rest.firstIndex(of: "?") {
            query = queryItems(String(rest[rest.index(after: q)...]))
            rest = rest[..<q]
        }
        let segments = rest.split(separator: "/", omittingEmptySubsequences: true).map { URIComponent.decode(String($0)) ?? String($0) }
        guard let head = segments.first?.lowercased() else { return nil }
        let tail = Array(segments.dropFirst())
        func param(_ name: String) -> String? {
            guard let v = query.first(where: { $0.name == name })?.value, !v.isEmpty else { return nil }
            return v
        }

        switch head {
        case "board": return .tab(.board)
        // The board's search field is always on screen; old search links land there.
        case "search": return .tab(.board)
        case "inbox":
            if let id = tail.first, !id.isEmpty { return .push(.triage(sessionId: id)) }
            return .tab(.inbox)
        case "settings":
            let patch = ThemePicker.themeLinkPrefs(queryItems: query)
            return .tab(.settings, themes: patch == ThemePicker.ThemePrefsPatch() ? nil : patch)
        case "ticket":
            guard let key = tail.first, !key.isEmpty else { return nil }
            // Changes is a built-in tab here; "plugin:git:changes" links open it.
            let tab = ChangesTab.ticketTabFrom(param("tab"))
            return .push(.ticket(key: key, tab: tab))
        case "project":
            guard let id = tail.first, !id.isEmpty else { return nil }
            return .push(.project(id: id))
        case "driver":
            guard let id = tail.first, !id.isEmpty else { return nil }
            return .push(.driver(id: id))
        case "prompts": return .push(.prompts)
        case "prompt":
            guard let id = tail.first, !id.isEmpty else { return nil }
            return .push(.prompt(id: id))
        case "projects": return .sheet(.projects)
        case "new": return .sheet(.newSession(projectId: param("projectId"), key: param("key")))
        case "watcher": return .sheet(.watcher(id: param("id")))
        case "connect": return .sheet(.connect)
        case "pair": return .sheet(.pair(url: param("url"), token: param("token")))
        case "scan": return .cover(.scan)
        default: return nil
        }
    }

    /// `a=1&b=%2F` → decoded items. A value that doesn't decode (a stray %) is kept as written.
    /// `+` stays a plus (encodeURIComponent never writes one for a space).
    static func queryItems(_ query: String) -> [URLQueryItem] {
        query.split(separator: "&", omittingEmptySubsequences: true).map { part in
            guard let eq = part.firstIndex(of: "=") else {
                return URLQueryItem(name: URIComponent.decode(String(part)) ?? String(part), value: "")
            }
            let name = String(part[..<eq])
            let value = String(part[part.index(after: eq)...])
            return URLQueryItem(name: URIComponent.decode(name) ?? name, value: URIComponent.decode(value) ?? value)
        }
    }
}
