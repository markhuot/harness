import Foundation

// Port of shared/src/keys.ts: ticket and project keys, and the remote-ID display rules.
//
// The TS regexes are ASCII classes without the `u` flag, so every check here works on Unicode
// scalars with explicit ASCII ranges (Swift's Character/grapheme matching and Unicode `\d`
// would accept more than JavaScript does).

/// Something with a ticket key and, optionally, a linked remote item's key (`externalRef.key`).
public protocol TicketKeyed {
    var key: String { get }
    /// `externalRef?.key`: nil when the ticket isn't linked to a remote item.
    var externalRefKey: String? { get }
}

extension Ticket: TicketKeyed {
    public var externalRefKey: String? { externalRef?.key }
}

/// A related ticket always carries a remote ID: `externalKey`.
extension RelatedTicket: TicketKeyed {
    public var externalRefKey: String? { externalKey }
}

public enum Keys {
    public struct TicketKey: Codable, Equatable, Sendable {
        public var prefix: String
        public var number: Int
        public init(prefix: String, number: Int) {
            self.prefix = prefix
            self.number = number
        }
    }

    public struct ProjectKeyCheck: Codable, Equatable, Sendable {
        /// The trimmed, upper-cased key.
        public var key: String
        /// Why the key is invalid; nil when it's fine.
        public var error: String?
        public init(key: String, error: String?) {
            self.key = key
            self.error = error
        }
    }

    /// Prefixes the service reserves for its own session keys (TRIAGE-n).
    public static let reservedProjectKeys: [String] = ["TRIAGE"]

    /// Derive a project key from a directory path: ~/work/nytimes → NYTIMES, my-app → MYAPP.
    public static func projectKeyFromPath(_ path: String) -> String {
        var scalars = Array(path.unicodeScalars)
        while scalars.last == "/" { scalars.removeLast() }
        let base = scalars.split(separator: "/", omittingEmptySubsequences: false).last ?? []
        let upper = String(String.UnicodeScalarView(base)).uppercased()
        let key = String(String.UnicodeScalarView(upper.unicodeScalars.filter { isUpperASCII($0) || isDigitASCII($0) }))
        if key.isEmpty { return "PROJ" }
        // Keys must start with a letter so they can't be confused with numbers (ASCII, so
        // prefix(16) counts the same as JS slice).
        return isUpperASCII(key.unicodeScalars.first!) ? String(key.prefix(16)) : String(("P" + key).prefix(16))
    }

    /// Parse "NYTIMES-12" → (NYTIMES, 12); nil when it isn't a ticket key. A number past Int.max
    /// is nil here, where JS would return an inexact Double.
    public static func parseTicketKey(_ key: String) -> TicketKey? {
        let s = Array(key.trimmingJSWhitespace().uppercased().unicodeScalars)
        guard let dash = s.firstIndex(of: "-"), dash > 0, isUpperASCII(s[0]) else { return nil }
        let prefix = s[..<dash]
        guard prefix.allSatisfy({ isUpperASCII($0) || isDigitASCII($0) || $0 == "_" }) else { return nil }
        let digits = s[(dash + 1)...]
        guard !digits.isEmpty, digits.allSatisfy(isDigitASCII) else { return nil }
        guard let number = Int(String(String.UnicodeScalarView(digits))) else { return nil }
        return TicketKey(prefix: String(String.UnicodeScalarView(prefix)), number: number)
    }

    public static func isTicketKey(_ key: String) -> Bool {
        parseTicketKey(key) != nil
    }

    /// PROJECT_KEY_RE (`/^[A-Z][A-Z0-9]{0,15}$/`): an upper-case letter and up to 15 letters/digits.
    public static func matchesProjectKeyPattern(_ key: String) -> Bool {
        let s = Array(key.unicodeScalars)
        guard let first = s.first, isUpperASCII(first), s.count <= 16 else { return false }
        return s.dropFirst().allSatisfy { isUpperASCII($0) || isDigitASCII($0) }
    }

    /// Validate a user-typed project key. Input is trimmed and upper-cased first, so "hel" is HEL.
    public static func checkProjectKey(_ raw: String) -> ProjectKeyCheck {
        let key = raw.trimmingJSWhitespace().uppercased()
        let s = Array(key.unicodeScalars)
        guard let first = s.first else { return ProjectKeyCheck(key: key, error: "Enter a key") }
        if !isUpperASCII(first) { return ProjectKeyCheck(key: key, error: "Must start with a letter") }
        if !s.allSatisfy({ isUpperASCII($0) || isDigitASCII($0) }) { return ProjectKeyCheck(key: key, error: "Letters and digits only") }
        if s.count > 16 { return ProjectKeyCheck(key: key, error: "16 characters at most") }
        if reservedProjectKeys.contains(key) { return ProjectKeyCheck(key: key, error: "\(key) is reserved") }
        return ProjectKeyCheck(key: key, error: nil)
    }

    // MARK: Remote IDs (DESIGN.md "Remote IDs")

    /// The identifier to show for a ticket: its remote ID when it's linked to one, else its key.
    public static func displayKey(_ t: some TicketKeyed) -> String {
        if let remote = t.externalRefKey, !remote.isEmpty { return remote }
        return t.key
    }

    /// The local key to show next to `displayKey`, or nil when the two are the same.
    public static func secondaryKey(_ t: some TicketKeyed) -> String? {
        jsEqual(displayKey(t), t.key) ? nil : t.key
    }

    /// "MH-62 · MH-124" (or just the key): one-line label for titles and menus.
    public static func keyLabel(_ t: some TicketKeyed) -> String {
        if let local = secondaryKey(t), !local.isEmpty { return "\(displayKey(t)) · \(local)" }
        return t.key
    }

    /// A ticket created before remote IDs had their own field: its key is its remote ID.
    public static func isLegacyMirror(_ t: some TicketKeyed) -> Bool {
        guard let remote = t.externalRefKey else { return false }
        return jsEqual(remote, t.key)
    }

    /// `===` on strings: code-point equality (Swift's `==` also equates canonically equivalent
    /// strings, such as a precomposed and a decomposed é).
    static func jsEqual(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }
    static func isUpperASCII(_ c: Unicode.Scalar) -> Bool { ("A"..."Z").contains(c) }
    static func isDigitASCII(_ c: Unicode.Scalar) -> Bool { ("0"..."9").contains(c) }
}
