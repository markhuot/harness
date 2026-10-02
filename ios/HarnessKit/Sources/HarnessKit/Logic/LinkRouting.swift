import Foundation

// Where a link tapped in markdown goes: http(s), mailto
// and any other scheme open outside the markdown (harness:// links that aren't file links route in
// the app); a file link (harness://file/…, or a bare relative or absolute path) opens the file
// viewer, resolved in the ticket or project the markdown belongs to.

public enum LinkRouting {
    public enum Target: Equatable, Sendable {
        /// Hand the URL to the system (or, for harness://, to the app's deep links).
        case external(String)
        /// Push the file viewer.
        case file(FileRouteParams)
        /// A file link with no ticket or project to resolve it in.
        case noRoot
    }

    /// The toast when a file link names no root.
    public static let noRootMessage = "That file link doesn't say which ticket or project it's in"
    /// The toast when the system can't open a link.
    public static let openFailedMessage = "Couldn't open that link"

    public static func target(_ url: String, context: FileLinkContext) -> Target {
        // `/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^harness:/i.test(url) ? null : parseFileLink(url)`
        if hasScheme(url) && !hasHarnessScheme(url) { return .external(url) }
        guard let link = FileLinks.parseFileLink(url) else { return .external(url) }
        guard let params = FileViewer.fileRouteFor(link, context: context) else { return .noRoot }
        return .file(params)
    }

    /// `/^[a-z][a-z0-9+.-]*:/i`
    static func hasScheme(_ url: String) -> Bool {
        var it = url.unicodeScalars.makeIterator()
        guard let first = it.next(), isASCIILetter(first) else { return false }
        while let c = it.next() {
            if c == ":" { return true }
            guard isASCIILetter(c) || ("0"..."9").contains(c) || c == "+" || c == "." || c == "-" else { return false }
        }
        return false
    }

    /// `/^harness:/i`
    static func hasHarnessScheme(_ url: String) -> Bool {
        let head = Array(url.unicodeScalars.prefix(8))
        return head.count == 8 && String(String.UnicodeScalarView(head)).lowercased() == "harness:"
    }

    private static func isASCIILetter(_ c: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(c) || ("A"..."Z").contains(c)
    }
}
