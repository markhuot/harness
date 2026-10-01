import Foundation

// Port of mobile/src/lib/related.ts. Remote IDs (DESIGN.md "Remote IDs"): the tickets that share
// one. A ticket's detail carries `relatedTickets` (other tickets linked to the remote ID it was asked
// for or carries), and a remote ID that no local key matches 404s with RemoteKeyMatches. The fetched
// list is a snapshot; relatedOf folds in the loaded tickets so a link made or removed since shows
// right away.
//
// Keys are compared the way JS compares strings, by code unit after `toUpperCase()` (Swift's String
// `==` and hashing would merge a precomposed and a decomposed É). The loaded tickets come in as an
// array in the TS map's insertion order, because that order decides ties (JS's sort is stable) and
// which of two same-key tickets wins.

public enum Related {
    /// What the Remote ID field saves (`remoteIdPatch`): link (the key upper-cased, with an optional
    /// URL), unlink, or an error to show. Encodes as the TS object (`{ externalRef }` or `{ error }`).
    public enum RemoteIdPatch: Codable, Sendable, Equatable {
        case link(key: String, url: String?)
        case unlink
        case error(String)

        private enum CodingKeys: String, CodingKey { case externalRef, error }
        private struct Ref: Codable { var key: String; @Nullable var url: String? }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if let error = try c.decodeIfPresent(String.self, forKey: .error) {
                self = .error(error)
            } else if let ref = try c.decodeIfPresent(Ref.self, forKey: .externalRef) {
                self = .link(key: ref.key, url: ref.url)
            } else if c.contains(.externalRef) {
                self = .unlink
            } else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "neither externalRef nor error"))
            }
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .link(key, url): try c.encode(Ref(key: key, url: url), forKey: .externalRef)
            case .unlink: try c.encodeNil(forKey: .externalRef)
            case let .error(message): try c.encode(message, forKey: .error)
            }
        }

        /// The `externalRef` field of an UpdateTicketBody for this patch; nil for an error.
        public var externalRefInput: Patch<ExternalRefInput>? {
            switch self {
            case let .link(key, url): .value(ExternalRefInput(key: key, url: Patch(url)))
            case .unlink: .null
            case .error: nil
            }
        }
    }

    /// The tickets sharing a remote ID with `ticket`: linked to its own remote ID, or to its key (a
    /// native MH-62 lists the tickets linked to Jira MH-62). Never the ticket itself or a draft. A
    /// loaded ticket wins over its fetched entry (it may have been relinked or unlinked since), and
    /// loaded ones the fetch didn't know about come first (they're the newest).
    ///
    /// `tickets` is the loaded tickets in the store's order (TS: `Object.values(tickets)`).
    public static func relatedOf(_ tickets: [Ticket], _ ticket: Ticket, fetched: [RelatedTicket]?) -> [RelatedTicket] {
        let selfKey = up(ticket.key)
        var ids: Set<[UInt16]> = [selfKey]
        if let remote = ticket.externalRef?.key, !remote.isEmpty { ids.insert(up(remote)) }
        func matches(_ t: Ticket) -> Bool {
            guard t.draft != true, up(t.key) != selfKey, let remote = t.externalRef?.key, !remote.isEmpty else { return false }
            return ids.contains(up(remote))
        }
        var loaded: [[UInt16]: Ticket] = [:]
        for t in tickets { loaded[up(t.key)] = t }

        var order: [[UInt16]] = []
        var out: [[UInt16]: RelatedTicket] = [:]
        func put(_ k: [UInt16], _ r: RelatedTicket) {
            if out[k] == nil { order.append(k) }
            out[k] = r
        }
        // Newest first; enumerated so equal createdAt keeps the store's order, like JS's stable sort.
        let live = tickets.enumerated().filter { matches($0.element) }
            .sorted { $0.element.createdAt != $1.element.createdAt ? $0.element.createdAt > $1.element.createdAt : $0.offset < $1.offset }
            .map(\.element)
        let known = Set((fetched ?? []).map { up($0.key) })
        for t in live where !known.contains(up(t.key)) { put(up(t.key), asRelated(t)) }
        for r in fetched ?? [] {
            let k = up(r.key)
            if k == selfKey || out[k] != nil { continue }
            if let t = loaded[k] {
                if matches(t) { put(k, asRelated(t)) }
            } else {
                put(k, r)
            }
        }
        return order.compactMap { out[$0] }
    }

    /// `relatedOf` over a `[id: Ticket]` map. Swift dictionaries have no order, so ties between equal
    /// `createdAt` (and duplicate keys) are broken by id here; pass the array form to keep the store's order.
    public static func relatedOf(_ tickets: [String: Ticket], _ ticket: Ticket, fetched: [RelatedTicket]?) -> [RelatedTicket] {
        relatedOf(tickets.sorted { $0.key < $1.key }.map(\.value), ticket, fetched: fetched)
    }

    /// "MH-62 · MH-124" for a related ticket (it always carries a remote ID).
    public static func relatedLabel(_ r: RelatedTicket) -> String {
        Keys.keyLabel(RelatedKeyed(key: r.key, externalRefKey: r.externalKey))
    }

    /// The RemoteKeyMatches a ticket lookup's 404 carries, when the key asked for is only a remote ID.
    /// (TS passes the entries through unchecked; here entries that don't decode as RelatedTicket make it nil.)
    public static func remoteMatchesOf(_ error: any Error) -> RemoteKeyMatches? {
        guard let e = error as? HarnessAPIError, e.status == 404, case let .object(d)? = e.data else { return nil }
        guard case let .string(requested)? = d["requested"], case let .array(list)? = d["relatedTickets"], !list.isEmpty else { return nil }
        guard let related = try? JSONValue.array(list).decode(as: [RelatedTicket].self) else { return nil }
        return RemoteKeyMatches(requested: requested, relatedTickets: related)
    }

    /// What the Remote ID field saves: the typed key upper-cased (and a URL, when given), unlink, or an
    /// error. nil when nothing changed. `valid` is isTicketKey, injected so the rule stays the
    /// dependency field's.
    public static func remoteIdPatch(
        current: (key: String, url: String?)?,
        key rawKey: String,
        url rawURL: String,
        valid: (String) -> Bool = Keys.isTicketKey
    ) -> RemoteIdPatch? {
        let key = JSCompat.trim(rawKey).uppercased()
        let trimmedURL = JSCompat.trim(rawURL)
        let url: String? = trimmedURL.isEmpty ? nil : trimmedURL
        if key.isEmpty {
            if url != nil { return .error("Add the remote ID the link points to") }
            return current != nil ? .unlink : nil
        }
        if !valid(key) { return .error("Not a ticket key: \(key)") }
        if let url, !isHTTPURL(url) { return .error("The link must start with http:// or https://") }
        if let current, up(current.key) == Array(key.utf16), current.url.map({ Array($0.utf16) }) == url.map({ Array($0.utf16) }) {
            return nil
        }
        return .link(key: key, url: url)
    }

    /// Whether a dependency chip opens something: a key the service 404'd doesn't, unless it's a remote
    /// ID some tickets carry (it opens the Remote ID screen listing them).
    public static func depOpens(key: String, missing: Bool?, byRemoteKey: [String: [RelatedTicket]]) -> Bool {
        if missing != true { return true }
        let k = up(key)
        return byRemoteKey.contains { Array($0.key.utf16) == k && !$0.value.isEmpty }
    }

    // MARK: Helpers

    /// `k.toUpperCase()` as code units, for JS-style `===`, Set and Map keys.
    private static func up(_ k: String) -> [UInt16] { Array(k.uppercased().utf16) }

    private static func asRelated(_ t: Ticket) -> RelatedTicket {
        RelatedTicket(key: t.key, title: t.title, status: t.status, projectId: t.projectId, externalKey: t.externalRef?.key ?? "")
    }

    /// `/^https?:\/\/\S+$/i`: the scheme matches ASCII case-insensitively (non-unicode `i` never folds
    /// a non-ASCII letter onto an ASCII one), and `\S` is JS's non-whitespace.
    private static func isHTTPURL(_ url: String) -> Bool {
        let s = Array(url.unicodeScalars)
        func lower(_ c: Unicode.Scalar) -> Unicode.Scalar { ("A"..."Z").contains(c) ? Unicode.Scalar(c.value + 32)! : c }
        let http = Array("http".unicodeScalars)
        guard s.count > 4, zip(s.prefix(4), http).allSatisfy({ lower($0) == $1 }) else { return false }
        var i = 4
        if lower(s[i]) == "s" { i += 1 }
        let sep = Array("://".unicodeScalars)
        guard s.count > i + sep.count, Array(s[i ..< i + sep.count]) == sep else { return false }
        return s[(i + sep.count)...].allSatisfy { !JSCompat.isWhitespace($0) }
    }

    private struct RelatedKeyed: TicketKeyed {
        let key: String
        let externalRefKey: String?
    }
}
