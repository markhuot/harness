import Foundation

// Where the Changes tab gets its data. Today that's the git plugin's routes
// (plugins/git/server.ts: /plugins/git/api/{changes,log,file}?ticket=KEY). When the service grows
// a core Changes API, it gets a conformance of its own and the tab switches by changing one line
// (ChangesStore's `source`).

/// Which side of a changed file to read: the base ("old") or the branch/worktree ("new").
public enum ChangesSide: String, Sendable, Equatable {
    case old, new
}

public protocol ChangesSource: Sendable {
    /// The ticket's diff. `maxBytes` caps the patch (the service's default when nil).
    func changes(ticket: String, maxBytes: Int?) async throws -> Changes
    /// The ticket branch's commits since its base.
    func log(ticket: String, limit: Int?) async throws -> ChangesLog
    /// One side of a changed file, for expanding unchanged context; nil when that side doesn't exist.
    /// `ref` is the base commit for the old side (Changes.baseSha); the new side ignores it.
    func file(ticket: String, side: ChangesSide, path: String, ref: String?) async throws -> String?
}

/// The git plugin's routes, through the service's authenticated plugin proxy.
public struct PluginChangesSource: ChangesSource {
    public let client: HarnessClient

    public init(client: HarnessClient) {
        self.client = client
    }

    public static let base = "/plugins/git/api"

    public static func changesPath(ticket: String, maxBytes: Int? = nil) -> String {
        "\(base)/changes" + Query.build([("ticket", .str(ticket)), ("maxBytes", .int(maxBytes))])
    }

    public static func logPath(ticket: String, limit: Int? = nil) -> String {
        "\(base)/log" + Query.build([("ticket", .str(ticket)), ("limit", .int(limit))])
    }

    /// The plugin only reads `ref` for the old side (and for the new side of a pinned diff, which
    /// it fills in itself), so the new side leaves it out.
    public static func filePath(ticket: String, side: ChangesSide, path: String, ref: String?) -> String {
        "\(base)/file" + Query.build([("ticket", .str(ticket)), ("side", .str(side.rawValue)), ("path", .str(path)), ("ref", side == .old ? .str(ref) : nil)])
    }

    public func changes(ticket: String, maxBytes: Int?) async throws -> Changes {
        try await client.request("GET", Self.changesPath(ticket: ticket, maxBytes: maxBytes))
    }

    public func log(ticket: String, limit: Int?) async throws -> ChangesLog {
        try await client.request("GET", Self.logPath(ticket: ticket, limit: limit))
    }

    public func file(ticket: String, side: ChangesSide, path: String, ref: String?) async throws -> String? {
        let r: ChangesFileContents = try await client.request("GET", Self.filePath(ticket: ticket, side: side, path: path, ref: ref))
        return r.contents
    }
}
