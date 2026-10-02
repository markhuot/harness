import Foundation
import Observation

// App state that outlives a connection —
// preferences, the saved servers and which one is active (tokens in the Keychain), pairing — plus
// the one BoardStore for the active server, rebuilt when the server, its token or the nonce changes.
// Storage goes through `SecureStorage` (KeychainStorage in the app, MemoryStorage in tests).

/// The Keychain as a string store. Keys match the 1.x React Native app's expo-secure-store keys,
/// so its saved servers, tokens and preferences carry over.
public protocol SecureStorage: Sendable {
    func get(_ key: String) throws -> String?
    func set(_ key: String, _ value: String) throws
    func delete(_ key: String) throws
}

public enum StorageKeys {
    public static let servers = "harness.servers"
    public static let prefs = "harness.prefs"
    public static func token(_ serverId: String) -> String { "harness.token.\(serverId)" }
}

/// An in-memory SecureStorage for tests and previews. `failWrites` makes every set throw.
public final class MemoryStorage: SecureStorage, @unchecked Sendable {
    public struct WriteFailed: Error, LocalizedError {
        public var errorDescription: String? { "write failed" }
    }

    private let lock = NSLock()
    private var values: [String: String]
    public var failWrites = false

    public init(_ values: [String: String] = [:]) { self.values = values }

    public var snapshot: [String: String] { lock.withLock { values } }

    public func get(_ key: String) throws -> String? { lock.withLock { values[key] } }

    public func set(_ key: String, _ value: String) throws {
        try lock.withLock {
            if failWrites { throw WriteFailed() }
            values[key] = value
        }
    }

    public func delete(_ key: String) throws { _ = lock.withLock { values.removeValue(forKey: key) } }
}

/// The saved server in use, with its token.
public struct ActiveServer: Equatable, Hashable, Sendable {
    public var server: SavedServer
    public var token: String

    public init(server: SavedServer, token: String) {
        self.server = server
        self.token = token
    }

    public var id: String { server.id }
    public var name: String { server.name }
    public var baseUrl: String { server.baseUrl }
}

@MainActor
@Observable
public final class AppModel {
    public typealias Probe = @Sendable (ServerAddress) async -> Connection.ProbeResult
    public typealias StoreFactory = @MainActor (ActiveServer, Prefs) -> BoardStore

    public private(set) var loaded = false
    public private(set) var prefs = Prefs.defaults
    public private(set) var servers: [SavedServer] = []
    public private(set) var active: ActiveServer?
    /// Bumped to force the active connection to rebuild (e.g. after a re-pair with a new token).
    public private(set) var connectionNonce = 0
    /// The live store for `active` (nil without one, or without a store factory).
    public private(set) var store: BoardStore?

    @ObservationIgnored private let storage: any SecureStorage
    @ObservationIgnored private let probe: Probe
    @ObservationIgnored private let makeStore: StoreFactory?
    @ObservationIgnored private let now: () -> Double
    @ObservationIgnored private let makeId: () -> String
    @ObservationIgnored private var storeKey: String?

    public init(
        storage: any SecureStorage,
        probe: @escaping Probe = AppModel.liveProbe,
        makeStore: StoreFactory? = AppModel.liveStore,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
        makeId: (() -> String)? = nil
    ) {
        self.storage = storage
        self.probe = probe
        self.makeStore = makeStore
        self.now = now
        self.makeId = makeId ?? { AppModel.newServerId(now: now()) }
    }

    public static let liveProbe: Probe = { a in
        await Connection.probeServer(baseUrl: a.baseUrl, token: a.token, transport: URLSessionTransport())
    }

    public static let liveStore: StoreFactory = { active, prefs in
        BoardStore(client: HarnessClient(baseUrl: active.baseUrl, token: active.token), boardProject: prefs.boardProject)
    }

    /// `srv-<Date.now() base 36>-<6 random base-36 chars>`, as the RN app makes them.
    public static func newServerId(now: Double) -> String {
        let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        let rand = String((0..<6).map { _ in digits[Int.random(in: 0..<36)] })
        return "srv-\(String(Int(now), radix: 36))-\(rand)"
    }

    // MARK: Loading

    /// Cold start: prefs and servers from storage, then the active server (prefs.activeServer, else
    /// the first saved one) when its token is there. Unreadable values fall back to defaults.
    public func load() {
        prefs = Prefs.normalize(data: (try? storage.get(StorageKeys.prefs))??.data(using: .utf8))
        servers = Self.decodeServers((try? storage.get(StorageKeys.servers)) ?? nil)
        if let current = servers.first(where: { $0.id == prefs.activeServer }) ?? servers.first,
           let token = (try? storage.get(StorageKeys.token(current.id))) ?? nil, !token.isEmpty {
            active = ActiveServer(server: current, token: token)
        }
        loaded = true
        syncStore()
    }

    static func decodeServers(_ json: String?) -> [SavedServer] {
        guard let data = json?.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([SavedServer].self, from: data)) ?? []
    }

    // MARK: Prefs

    public func setPref<V>(_ key: WritableKeyPath<Prefs, V>, _ value: V) {
        var next = prefs
        next[keyPath: key] = value
        setPrefs(next)
    }

    /// Replace the prefs and save them (a failed save is ignored, as in RN).
    public func setPrefs(_ next: Prefs) {
        prefs = next
        if let data = try? JSONEncoder().encode(next), let json = String(data: data, encoding: .utf8) {
            try? storage.set(StorageKeys.prefs, json)
        }
    }

    /// A settings link's theme picks.
    public func applyThemes(_ patch: ThemePicker.ThemePrefsPatch) {
        setPrefs(patch.applied(to: prefs))
    }

    /// The color theme on screen for this system appearance.
    public func resolvedTheme(systemDark: Bool) -> ResolvedThemeChoice {
        Themes.resolve(ThemeChoice(appearance: prefs.theme, lightTheme: prefs.lightTheme, darkTheme: prefs.darkTheme), systemDark: systemDark)
    }

    // MARK: Servers

    /// Probe (unless `skipProbe`), then save and activate. Returns the probe result; a Keychain
    /// failure is an `.error` failure. Errors are for the caller to show.
    @discardableResult
    public func pair(_ a: ServerAddress, skipProbe: Bool = false) async -> Connection.ProbeResult {
        let result: Connection.ProbeResult = skipProbe ? .ok(version: "") : await probe(a)
        guard case .ok = result else { return result }
        let up = Servers.upsertServer(servers, baseUrl: a.baseUrl, now: Int(now()), makeId: makeId)
        do {
            try storage.set(StorageKeys.token(up.server.id), a.token)
            try storage.set(StorageKeys.servers, Self.encodeServers(up.list))
        } catch {
            return .failure(Connection.ProbeFailure(kind: .error, message: "Couldn't save the token to the Keychain: \(error.localizedDescription)"))
        }
        servers = up.list
        active = ActiveServer(server: up.server, token: a.token)
        setPref(\.activeServer, up.server.id)
        connectionNonce += 1
        syncStore()
        return result
    }

    /// Switch to a saved server (nothing happens when it or its token is missing).
    public func activate(_ id: String) {
        guard let s = servers.first(where: { $0.id == id }),
              let token = (try? storage.get(StorageKeys.token(id))) ?? nil else { return }
        active = ActiveServer(server: s, token: token)
        setPref(\.activeServer, id)
        connectionNonce += 1
        syncStore()
    }

    /// Delete a server and its token; the next saved one (if any) becomes active.
    public func forget(_ id: String) {
        let removed = Servers.removeServer(servers, id: id, activeId: prefs.activeServer ?? active?.id)
        try? storage.delete(StorageKeys.token(id))
        try? storage.set(StorageKeys.servers, Self.encodeServers(removed.list))
        servers = removed.list
        setPref(\.activeServer, removed.active)
        if let next = removed.active, let s = removed.list.first(where: { $0.id == next }),
           let token = (try? storage.get(StorageKeys.token(next))) ?? nil {
            active = ActiveServer(server: s, token: token)
        } else {
            active = nil
        }
        connectionNonce += 1
        syncStore()
    }

    /// Rename a server; a blank name restores its host.
    public func rename(_ id: String, to name: String) {
        servers = Servers.renameServer(servers, id: id, name: name)
        if let a = active, a.id == id, let s = servers.first(where: { $0.id == id }) {
            active = ActiveServer(server: s, token: a.token)
        }
        try? storage.set(StorageKeys.servers, Self.encodeServers(servers))
    }

    static func encodeServers(_ list: [SavedServer]) -> String {
        (try? JSONEncoder().encode(list)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }

    // MARK: Store

    /// Which connection the store is for: changes when the server, its token or the nonce does.
    public var connectionKey: String? {
        active.map { "\($0.id):\(connectionNonce)" }
    }

    private func syncStore() {
        guard storeKey != connectionKey else { return }
        store?.close()
        store = nil
        storeKey = connectionKey
        guard let active, let makeStore else { return }
        let next = makeStore(active, prefs)
        store = next
        next.start()
    }

    /// Forward scene phases to the store (iOS drops the socket in the background).
    public func sceneBecameActive() { store?.sceneBecameActive() }

    public func sceneDidEnterBackground() { store?.sceneDidEnterBackground() }
}
