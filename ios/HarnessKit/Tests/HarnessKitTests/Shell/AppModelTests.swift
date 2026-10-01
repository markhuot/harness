import Foundation
import Synchronization
import Testing
@testable import HarnessKit

/// mobile/src/state/app.tsx: cold start, pairing, switching, forgetting and renaming servers, and
/// one BoardStore per connection.
@MainActor
@Suite("AppModel (mobile state/app.tsx)")
struct AppModelTests {
    static let mac = SavedServer(id: "srv-a", name: "mac:7717", baseUrl: "http://mac:7717", addedAt: 1)
    static let mini = SavedServer(id: "srv-b", name: "Mini", baseUrl: "http://mini:7717", addedAt: 2)

    static func saved(_ list: [SavedServer], tokens: [String: String] = [:], prefs: String? = nil) -> MemoryStorage {
        var values = [StorageKeys.servers: AppModel.encodeServers(list)]
        for (id, t) in tokens { values[StorageKeys.token(id)] = t }
        if let prefs { values[StorageKeys.prefs] = prefs }
        return MemoryStorage(values)
    }

    static func model(_ storage: MemoryStorage, probe: @escaping AppModel.Probe = { _ in .ok(version: "1") }) -> AppModel {
        var n = 0
        return AppModel(storage: storage, probe: probe, makeStore: nil, now: { 1_700_000_000_000 }, makeId: { n += 1; return "srv-new\(n)" })
    }

    // MARK: Cold start

    @Test func coldStartPicksThePreferredServer() {
        let m = Self.model(Self.saved([Self.mac, Self.mini], tokens: ["srv-a": "ta", "srv-b": "tb"], prefs: #"{"activeServer":"srv-b"}"#))
        #expect(!m.loaded)
        m.load()
        #expect(m.loaded)
        #expect(m.active == ActiveServer(server: Self.mini, token: "tb"))
        #expect(m.servers == [Self.mac, Self.mini])
    }

    @Test func coldStartFallsBackToTheFirstServer() {
        let m = Self.model(Self.saved([Self.mac, Self.mini], tokens: ["srv-a": "ta"], prefs: #"{"activeServer":"gone"}"#))
        m.load()
        #expect(m.active?.id == "srv-a")
    }

    @Test func coldStartWithoutATokenHasNoActiveServer() {
        let m = Self.model(Self.saved([Self.mac]))
        m.load()
        #expect(m.loaded && m.active == nil)
    }

    @Test func coldStartSurvivesDamagedStorage() {
        let m = Self.model(MemoryStorage([StorageKeys.servers: "{not json", StorageKeys.prefs: "[]"]))
        m.load()
        #expect(m.servers.isEmpty && m.prefs == .defaults && m.active == nil)
    }

    // MARK: Pairing

    @Test func pairingSavesTheTokenAndActivates() async throws {
        let storage = MemoryStorage()
        let m = Self.model(storage)
        m.load()
        let r = await m.pair(ServerAddress(baseUrl: "http://mac:7717", token: "tok"))
        #expect(r == .ok(version: "1"))
        #expect(m.active?.id == "srv-new1" && m.active?.token == "tok" && m.active?.name == "mac:7717")
        #expect(m.prefs.activeServer == "srv-new1")
        #expect(m.connectionNonce == 1)
        let snap = storage.snapshot
        #expect(snap[StorageKeys.token("srv-new1")] == "tok")
        #expect(AppModel.decodeServers(snap[StorageKeys.servers]) == m.servers)
        // The prefs blob round-trips through the RN normalizer's port.
        #expect(Prefs.normalize(data: snap[StorageKeys.prefs]?.data(using: .utf8)).activeServer == "srv-new1")
    }

    @Test func repairingTheSameMacReusesItsEntryAndRebuildsTheConnection() async {
        let m = Self.model(Self.saved([Self.mac], tokens: ["srv-a": "old"]))
        m.load()
        let key = m.connectionKey
        await m.pair(ServerAddress(baseUrl: "http://mac:7717", token: "new"))
        #expect(m.servers == [Self.mac])
        #expect(m.active == ActiveServer(server: Self.mac, token: "new"))
        #expect(m.connectionKey != key)
    }

    @Test func aFailedProbeChangesNothing() async {
        let failure = Connection.ProbeResult.failure(.init(kind: .unauthorized, message: Connection.unauthorizedMessage))
        let storage = MemoryStorage()
        let m = Self.model(storage, probe: { _ in failure })
        m.load()
        #expect(await m.pair(ServerAddress(baseUrl: "http://mac:7717", token: "t")) == failure)
        #expect(m.active == nil && m.servers.isEmpty && storage.snapshot.isEmpty)
    }

    @Test func skipProbeDoesntCallIt() async {
        let calls = Mutex(0)
        let m = Self.model(MemoryStorage(), probe: { _ in calls.withLock { $0 += 1 }; return .ok(version: "1") })
        m.load()
        #expect(await m.pair(ServerAddress(baseUrl: "http://mac:7717", token: "t"), skipProbe: true) == .ok(version: ""))
        #expect(calls.withLock { $0 } == 0)
        #expect(m.active != nil)
    }

    @Test func aKeychainFailureIsAnErrorAndNothingActivates() async {
        let storage = MemoryStorage()
        storage.failWrites = true
        let m = Self.model(storage)
        m.load()
        let r = await m.pair(ServerAddress(baseUrl: "http://mac:7717", token: "t"))
        guard case let .failure(f) = r else { Issue.record("expected a failure"); return }
        #expect(f.kind == .error)
        #expect(f.message.hasPrefix("Couldn't save the token to the Keychain: "))
        #expect(m.active == nil && m.servers.isEmpty)
    }

    // MARK: Switching, forgetting, renaming

    @Test func activateSwitchesAndBumpsTheNonce() {
        let m = Self.model(Self.saved([Self.mac, Self.mini], tokens: ["srv-a": "ta", "srv-b": "tb"]))
        m.load()
        m.activate("srv-b")
        #expect(m.active?.id == "srv-b" && m.prefs.activeServer == "srv-b" && m.connectionNonce == 1)
        // Unknown ids and missing tokens leave everything alone.
        m.activate("nope")
        #expect(m.active?.id == "srv-b" && m.connectionNonce == 1)
    }

    @Test func activateWithoutATokenDoesNothing() {
        let m = Self.model(Self.saved([Self.mac, Self.mini], tokens: ["srv-a": "ta"]))
        m.load()
        m.activate("srv-b")
        #expect(m.active?.id == "srv-a" && m.connectionNonce == 0)
    }

    @Test func forgettingTheActiveServerMovesToTheNext() {
        let storage = Self.saved([Self.mac, Self.mini], tokens: ["srv-a": "ta", "srv-b": "tb"], prefs: #"{"activeServer":"srv-a"}"#)
        let m = Self.model(storage)
        m.load()
        m.forget("srv-a")
        #expect(m.servers == [Self.mini])
        #expect(m.active?.id == "srv-b" && m.prefs.activeServer == "srv-b")
        #expect(storage.snapshot[StorageKeys.token("srv-a")] == nil)
        m.forget("srv-b")
        #expect(m.active == nil && m.servers.isEmpty && m.prefs.activeServer == nil)
    }

    @Test func forgettingAnotherServerKeepsTheActiveOne() {
        let m = Self.model(Self.saved([Self.mac, Self.mini], tokens: ["srv-a": "ta", "srv-b": "tb"], prefs: #"{"activeServer":"srv-a"}"#))
        m.load()
        m.forget("srv-b")
        #expect(m.active?.id == "srv-a" && m.servers == [Self.mac])
    }

    @Test func renameUpdatesTheActiveServerAndBlankRestoresTheHost() {
        let storage = Self.saved([Self.mac], tokens: ["srv-a": "ta"])
        let m = Self.model(storage)
        m.load()
        m.rename("srv-a", to: "  Studio  ")
        #expect(m.active?.name == "Studio")
        #expect(AppModel.decodeServers(storage.snapshot[StorageKeys.servers]).first?.name == "Studio")
        m.rename("srv-a", to: "   ")
        #expect(m.active?.name == "mac:7717")
        // Renaming isn't a new connection.
        #expect(m.connectionNonce == 0)
    }

    @Test func themeLinksAndPrefsPersist() throws {
        let storage = MemoryStorage()
        let m = Self.model(storage)
        m.load()
        let dark = try #require(Themes.themes(for: .dark).last?.id)
        m.applyThemes(ThemePicker.ThemePrefsPatch(theme: .dark, darkTheme: dark))
        #expect(m.resolvedTheme(systemDark: false).theme.id == dark)
        m.setPref(\.hideChildren, false)
        let reloaded = Self.model(storage)
        reloaded.load()
        #expect(reloaded.prefs.theme == .dark && reloaded.prefs.darkTheme == dark && !reloaded.prefs.hideChildren)
    }

    @Test func serverIdsLookLikeTheRNOnes() {
        let id = AppModel.newServerId(now: 1_700_000_000_000)
        #expect(id.hasPrefix("srv-\(String(1_700_000_000_000, radix: 36))-"))
        #expect(id.wholeMatch(of: /srv-[0-9a-z]+-[0-9a-z]{6}/) != nil)
    }

    // MARK: The store

    @Test func oneStorePerConnectionAndTheOldOneCloses() async {
        typealias Fakes = BoardStoreTests
        var sockets: [Fakes.FakeSocket] = []
        var made: [String] = []
        let storage = Self.saved([Self.mac, Self.mini], tokens: ["srv-a": "ta", "srv-b": "tb"])
        let m = AppModel(storage: storage, probe: { _ in .ok(version: "1") }, makeStore: { active, _ in
            made.append(active.id)
            return BoardStore(client: Fakes.FakeClient(), baseUrl: active.baseUrl, makeSocket: {
                let s = Fakes.FakeSocket()
                sockets.append(s)
                return s
            }, timers: ManualTimers())
        })
        m.load()
        #expect(made == ["srv-a"] && sockets.count == 1)
        let first = m.store
        m.rename("srv-a", to: "x")
        #expect(m.store === first)
        m.activate("srv-b")
        #expect(made == ["srv-a", "srv-b"] && m.store?.baseUrl == "http://mini:7717")
        #expect(await eventually { sockets[0].closed.withLock { $0 } })
        m.forget("srv-b")
        m.forget("srv-a")
        #expect(m.store == nil)
    }
}
