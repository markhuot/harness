import HarnessKit
import SwiftUI
import UIKit

// Opening links in rendered content: http(s) and mailto go to Safari (or Mail);
// a file link (harness://file/…, or a bare relative path) opens the file viewer, resolved in the
// ticket or project the markdown belongs to, which the screen that renders it provides with
// `.fileLinkScope(…)`; other harness:// links route in the app; ticket keys push the ticket.

extension EnvironmentValues {
    /// The ticket or project relative file links resolve in.
    @Entry var fileLinkContext = FileLinkContext()
}

extension View {
    /// Where file links in this subtree's markdown open: the ticket's folder, else the project's.
    func fileLinkScope(ticketKey: String? = nil, projectId: String? = nil) -> some View {
        environment(\.fileLinkContext, FileLinkContext(ticketKey: ticketKey, projectId: projectId))
    }

    /// `.fileLinkScope(FileViewer.triageLinkContext(…))` for a triage session.
    func fileLinkScope(_ context: FileLinkContext) -> some View {
        environment(\.fileLinkContext, context)
    }
}

/// Links inside an AttributedString carry their target in a private scheme, so any markdown URL
/// (a bare path with spaces, `src/a.ts#L3`) survives being a `URL`, and the view's OpenURLAction
/// can tell a ticket key from a link.
enum ContentLinkURL {
    static let scheme = "x-harness-content"

    static func link(_ raw: String) -> URL? { make("link", raw) }
    static func ticket(_ key: String) -> URL? { make("ticket", key) }

    enum Target: Equatable {
        case link(String)
        case ticket(String)
    }

    static func target(_ url: URL) -> Target? {
        guard url.scheme == scheme, let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let v = c.queryItems?.first(where: { $0.name == "v" })?.value else { return nil }
        switch c.host {
        case "link": return .link(v)
        case "ticket": return .ticket(v)
        default: return nil
        }
    }

    private static func make(_ kind: String, _ value: String) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        c.host = kind
        c.queryItems = [URLQueryItem(name: "v", value: value)]
        return c.url
    }
}

/// Opens one markdown link with the nearest scope.
struct ContentLinkOpener {
    let context: FileLinkContext
    let router: Router
    let toasts: ToastCenter

    @MainActor
    func open(_ url: String) {
        switch LinkRouting.target(url, context: context) {
        case let .file(params):
            router.push(.file(params))
        case .noRoot:
            toasts.show(LinkRouting.noRootMessage, kind: .error)
        case let .external(raw):
            guard let u = URL(string: raw) ?? URL(string: raw.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "") else {
                toasts.show(LinkRouting.openFailedMessage, kind: .error)
                return
            }
            // harness:// that isn't a file link is one of the app's own deep links.
            if u.scheme?.lowercased() == "harness" {
                if !router.open(url: u) { toasts.show(LinkRouting.openFailedMessage, kind: .error) }
                return
            }
            UIApplication.shared.open(u) { ok in
                if !ok { Task { @MainActor in toasts.show(LinkRouting.openFailedMessage, kind: .error) } }
            }
        }
    }

    @MainActor
    func openTicket(_ key: String) {
        router.push(.ticket(key: key, tab: nil))
    }

    /// The OpenURLAction for Text links built with ContentLinkURL; anything else goes to the system.
    @MainActor
    var action: OpenURLAction {
        OpenURLAction { url in
            switch ContentLinkURL.target(url) {
            case let .link(raw): open(raw)
            case let .ticket(key): openTicket(key)
            case nil: return .systemAction
            }
            return .handled
        }
    }
}

/// Applies the link opener for the nearest scope (or `override` when it names a root) to Text links.
struct ContentLinkHandling: ViewModifier {
    var override: FileLinkContext

    @Environment(\.fileLinkContext) private var scope
    @Environment(Router.self) private var router
    @Environment(ToastCenter.self) private var toasts

    func body(content: Content) -> some View {
        let named = override.ticketKey != nil || override.projectId != nil
        let opener = ContentLinkOpener(context: named ? override : scope, router: router, toasts: toasts)
        content.environment(\.openURL, opener.action)
    }
}
