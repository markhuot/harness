import Foundation

// "Viewed" marks on the Changes tab's diffs, like a GitHub PR review: a port of
// plugins/git/ui/viewed.ts. A mark stores the file's diff fingerprint (ChangesPatch.fingerprint), so
// a file the agent changes again after you viewed it reads as unviewed. Marks live in UserDefaults
// under one key, bounded per ticket (MAX_FILES) and in the number of tickets kept (MAX_TICKETS, the
// least recently written go first). Storage that's missing or holds garbage reads as "nothing
// viewed".
//
// Deliberate difference: the plugin keeps a ticket's marks as a JSON object, whose key order is the
// order marks were made (which decides the ones kept when a ticket passes MAX_FILES). Swift's JSON
// coding doesn't keep object key order, so here they're stored as an array of [path, fingerprint]
// pairs. The two never share storage (the plugin's is the web view's localStorage).

/// Where marks and prefs are kept: UserDefaults in the app, a dictionary in tests.
public protocol ChangesDefaults: AnyObject, Sendable {
    func string(forKey key: String) -> String?
    func setString(_ value: String, forKey key: String)
}

extension UserDefaults: ChangesDefaults {
    public func setString(_ value: String, forKey key: String) { set(value, forKey: key) }
}

/// In-memory ChangesDefaults for tests and previews.
public final class MemoryChangesDefaults: ChangesDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]

    public init(_ values: [String: String] = [:]) { self.values = values }

    public func string(forKey key: String) -> String? { lock.withLock { values[key] } }
    public func setString(_ value: String, forKey key: String) { lock.withLock { values[key] = value } }
}

/// A ticket's marks: path → fingerprint of the diff that was viewed, in the order they were made.
public struct ChangesViewed: Sendable, Equatable {
    public private(set) var entries: [(path: String, fingerprint: String)] = []

    public init(_ entries: [(path: String, fingerprint: String)] = []) {
        for e in entries { set(e.path, e.fingerprint) }
    }

    public var count: Int { entries.count }
    public var isEmpty: Bool { entries.isEmpty }

    public subscript(path: String) -> String? { entries.first { $0.path == path }?.fingerprint }

    /// Marks `path` (re-adding moves it to the end, which is what storage keeps when capped).
    public mutating func set(_ path: String, _ fingerprint: String) {
        remove(path)
        entries.append((path, fingerprint))
    }

    public mutating func remove(_ path: String) { entries.removeAll { $0.path == path } }

    public static func == (a: ChangesViewed, b: ChangesViewed) -> Bool {
        a.entries.count == b.entries.count && zip(a.entries, b.entries).allSatisfy { $0.path == $1.path && $0.fingerprint == $1.fingerprint }
    }
}

public enum ChangesViewedStore {
    public static let key = "harness.git.viewed"
    public static let maxTickets = 40
    public static let maxFiles = 400

    private struct TicketMarks: Codable {
        /// Last write (epoch ms), for evicting the least recently used tickets.
        var at: Double
        var files: [[String]]
    }

    private static func readAll(_ store: any ChangesDefaults) -> [String: JSONValue] {
        guard let raw = store.string(forKey: key), let data = raw.data(using: .utf8),
              case let .object(all)? = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [:] }
        return all
    }

    private static func marks(_ v: JSONValue?) -> TicketMarks? {
        guard case let .object(o)? = v, case let .number(at)? = o["at"] else { return nil }
        var files: [[String]] = []
        if case let .array(list)? = o["files"] {
            for item in list {
                guard case let .array(pair) = item, pair.count == 2, case let .string(p) = pair[0], case let .string(fp) = pair[1] else { continue }
                files.append([p, fp])
            }
        }
        return TicketMarks(at: at, files: files)
    }

    /// The files marked viewed on a ticket. Malformed entries are skipped.
    public static func read(_ ticket: String, from store: any ChangesDefaults) -> ChangesViewed {
        ChangesViewed((marks(readAll(store)[ticket])?.files ?? []).map { ($0[0], $0[1]) })
    }

    /// Replace a ticket's marks (empty marks remove the ticket). Keeps at most `maxFiles` marks for
    /// it and `maxTickets` tickets overall, evicting the tickets written longest ago.
    public static func save(_ ticket: String, _ viewed: ChangesViewed, to store: any ChangesDefaults, now: Double = Date().timeIntervalSince1970 * 1000) {
        var all: [String: TicketMarks] = [:]
        for (k, v) in readAll(store) where k != ticket {
            if let m = marks(v) { all[k] = m }
        }
        if !viewed.isEmpty {
            all[ticket] = TicketMarks(at: now, files: viewed.entries.suffix(maxFiles).map { [$0.path, $0.fingerprint] })
        }
        // Newest first; equal times by key, since a dictionary has no insertion order to fall back on.
        let keep = all.sorted { $0.value.at != $1.value.at ? $0.value.at > $1.value.at : $0.key < $1.key }.prefix(maxTickets)
        guard let data = try? JSONEncoder().encode(Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })) else { return }
        store.setString(String(decoding: data, as: UTF8.self), forKey: key)
    }

    /// The tickets that have marks (for tests and debugging), sorted.
    public static func tickets(in store: any ChangesDefaults) -> [String] {
        readAll(store).keys.filter { marks(readAll(store)[$0]) != nil }.sorted()
    }

    /// Drop marks that no longer apply: files whose diff changed since they were viewed, and files
    /// that aren't changed any more. `current` holds the fingerprint of every file in the parsed diff;
    /// `changed` lists every changed path, which can be longer than `current` when the diff was
    /// truncated. Those unparsed files keep their mark, since there's nothing to compare it with.
    public static func prune(_ viewed: ChangesViewed, current: [String: String], changed: Set<String>) -> ChangesViewed {
        ChangesViewed(viewed.entries.filter { e in
            if let now = current[e.path] { return now == e.fingerprint }
            return changed.contains(e.path)
        })
    }

    /// Whether a file's diff is collapsed. Viewed files collapse, others don't, unless the disclosure
    /// arrow was toggled this session for this same version of the diff.
    public static func isCollapsed(viewed: Bool, toggle: (fingerprint: String, collapsed: Bool)?, fingerprint: String) -> Bool {
        if let toggle, toggle.fingerprint == fingerprint { return toggle.collapsed }
        return viewed
    }
}
