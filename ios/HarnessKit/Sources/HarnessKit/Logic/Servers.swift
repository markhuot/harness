import Foundation

// Pure saved-server list operations and the SavedServer record (the shape the 1.x React Native
// app stored too, so its saved servers carry over). A server is identified by its base URL:
// pairing the same Mac again reuses its entry instead of adding a duplicate. Tokens are stored
// separately, per id.

/// One saved server, as the app persists it (a JSON array of these).
public struct SavedServer: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var baseUrl: String
    /// When it was added, in milliseconds since 1970 (JS `Date.now()`).
    public var addedAt: Int

    public init(id: String, name: String, baseUrl: String, addedAt: Int) {
        self.id = id
        self.name = name
        self.baseUrl = baseUrl
        self.addedAt = addedAt
    }
}

public enum Servers {
    public struct UpsertResult: Equatable, Sendable {
        public var list: [SavedServer]
        public var server: SavedServer
        public var added: Bool
    }

    public struct RemoveResult: Equatable, Sendable {
        public var list: [SavedServer]
        public var active: String?
    }

    /// Add a server for `baseUrl`, or return the existing entry (unchanged, `added` false).
    /// `makeId` is called only when a server is added.
    public static func upsertServer(_ list: [SavedServer], baseUrl: String, now: Int, makeId: () -> String) -> UpsertResult {
        if let existing = list.first(where: { same($0.baseUrl, baseUrl) }) {
            return UpsertResult(list: list, server: existing, added: false)
        }
        let server = SavedServer(id: makeId(), name: MobilePair.displayHost(baseUrl), baseUrl: baseUrl, addedAt: now)
        return UpsertResult(list: list + [server], server: server, added: true)
    }

    /// Remove every server with `id`. When it was the active one, the first remaining server
    /// becomes active (or none).
    public static func removeServer(_ list: [SavedServer], id: String, activeId: String?) -> RemoveResult {
        let next = list.filter { !same($0.id, id) }
        let active = activeId.map { same($0, id) } == true ? next.first?.id : activeId
        return RemoveResult(list: next, active: active)
    }

    /// Rename the server with `id`; a blank name restores its host name.
    public static func renameServer(_ list: [SavedServer], id: String, name: String) -> [SavedServer] {
        let n = name.trimmingJSWhitespace()
        return list.map { s in
            guard same(s.id, id) else { return s }
            var renamed = s
            renamed.name = n.isEmpty ? MobilePair.displayHost(s.baseUrl) : n
            return renamed
        }
    }

    /// `===`: code-point equality, not Swift's canonical equivalence.
    private static func same(_ a: String, _ b: String) -> Bool {
        a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }
}
