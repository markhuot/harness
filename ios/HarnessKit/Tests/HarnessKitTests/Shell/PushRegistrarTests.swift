import Foundation
import Synchronization
import Testing
@testable import HarnessKit

/// Registering this device's APNs token with every saved Mac, and taking it off a forgotten one.
@MainActor
@Suite("PushRegistrar")
struct PushRegistrarTests {
    /// Every call any fake client got, as "<baseUrl> register <token>" / "<baseUrl> remove <id>".
    final class Calls: Sendable {
        let log = Mutex<[String]>([])
        let failing = Mutex<Set<String>>([])
        var all: [String] { log.withLock { $0 } }
        func reset() { log.withLock { $0 = [] } }
    }

    struct FakePushClient: PushClient {
        let server: ActiveServer
        let calls: Calls
        struct Down: Error {}

        func registerDevice(_ body: RegisterDeviceBody) async throws -> Device {
            calls.log.withLock { $0.append("\(server.baseUrl) register \(body.apnsToken)") }
            if calls.failing.withLock({ $0.contains(server.baseUrl) }) { throw Down() }
            return Device(id: body.id, platform: body.platform, name: body.name, topic: body.topic ?? "", environment: body.environment,
                          tokenSuffix: String(body.apnsToken.suffix(8)), createdAt: 1, lastSeen: 1)
        }

        func removeDevice(_ id: String) async throws -> OkResponse {
            calls.log.withLock { $0.append("\(server.baseUrl) remove \(id)") }
            if calls.failing.withLock({ $0.contains(server.baseUrl) }) { throw Down() }
            return OkResponse(ok: true)
        }
    }

    static let mac = ActiveServer(server: SavedServer(id: "srv-a", name: "mac", baseUrl: "http://mac:7717", addedAt: 1), token: "ta")
    static let mini = ActiveServer(server: SavedServer(id: "srv-b", name: "Mini", baseUrl: "http://mini:7717", addedAt: 2), token: "tb")

    func registrar(_ calls: Calls, environment: ApnsEnvironment = .sandbox) -> PushRegistrar {
        PushRegistrar(deviceId: "dev-1", name: "Mark's iPhone", environment: environment) { FakePushClient(server: $0, calls: calls) }
    }

    @Test func theBodyNamesThisDeviceAndTheSharedTopic() {
        let r = registrar(Calls(), environment: .production)
        #expect(r.body(token: "abcd") == RegisterDeviceBody(
            id: "dev-1", platform: .ios, name: "Mark's iPhone", apnsToken: "abcd", environment: .production, topic: "com.markhuot.harness"))
    }

    @Test func nothingIsSentBeforeTheSystemHandsOverAToken() async {
        let calls = Calls()
        let r = registrar(calls)
        await r.sync([Self.mac, Self.mini])
        #expect(calls.all.isEmpty)
    }

    @Test func theTokenGoesToEverySavedMacOnce() async {
        let calls = Calls()
        let r = registrar(calls)
        await r.setToken("tok1", servers: [Self.mac, Self.mini])
        #expect(Set(calls.all) == ["http://mac:7717 register tok1", "http://mini:7717 register tok1"])
        #expect(r.isRegistered("srv-a") && r.isRegistered("srv-b"))
        calls.reset()
        // Launch-time, foreground and server-list syncs after that are no-ops.
        await r.sync([Self.mac, Self.mini])
        await r.setToken("tok1", servers: [Self.mac, Self.mini])
        #expect(calls.all.isEmpty)
    }

    @Test func aNewMacOrARepairRegistersThere() async {
        let calls = Calls()
        let r = registrar(calls)
        await r.setToken("tok1", servers: [Self.mac])
        calls.reset()
        await r.sync([Self.mac, Self.mini])
        #expect(calls.all == ["http://mini:7717 register tok1"])
        calls.reset()
        // Paired again: same server id, a new bearer token.
        var repaired = Self.mac
        repaired.token = "ta2"
        await r.sync([repaired, Self.mini])
        #expect(calls.all == ["http://mac:7717 register tok1"])
    }

    @Test func aChangedTokenRegistersEverywhereAgain() async {
        let calls = Calls()
        let r = registrar(calls)
        await r.setToken("tok1", servers: [Self.mac, Self.mini])
        calls.reset()
        await r.setToken("tok2", servers: [Self.mac, Self.mini])
        #expect(Set(calls.all) == ["http://mac:7717 register tok2", "http://mini:7717 register tok2"])
    }

    @Test func anUnreachableMacIsTriedAgainOnTheNextSync() async {
        let calls = Calls()
        calls.failing.withLock { $0 = ["http://mini:7717"] }
        let r = registrar(calls)
        await r.setToken("tok1", servers: [Self.mac, Self.mini])
        #expect(r.isRegistered("srv-a") && !r.isRegistered("srv-b"))
        #expect(r.errors["srv-b"] != nil && r.errors["srv-a"] == nil)
        calls.reset()
        calls.failing.withLock { $0 = [] }
        await r.sync([Self.mac, Self.mini])
        #expect(calls.all == ["http://mini:7717 register tok1"])
        #expect(r.isRegistered("srv-b") && r.errors["srv-b"] == nil)
    }

    @Test func forgettingAMacUnregistersThisDeviceThere() async {
        let calls = Calls()
        let r = registrar(calls)
        await r.setToken("tok1", servers: [Self.mac, Self.mini])
        calls.reset()
        await r.unregister(Self.mini)
        #expect(calls.all == ["http://mini:7717 remove dev-1"])
        #expect(!r.isRegistered("srv-b"))
        // Best effort: a Mac that can't be reached doesn't throw.
        calls.failing.withLock { $0 = ["http://mac:7717"] }
        await r.unregister(Self.mac)
        #expect(calls.all.last == "http://mac:7717 remove dev-1")
    }
}
