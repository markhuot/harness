import Foundation
import Testing
@testable import HarnessKit

/// What push registration needs from AppModel: every saved Mac with its token, a stable device
/// id, and a word before a Mac's token is deleted.
@MainActor
@Suite("AppModel push support")
struct AppModelPushTests {
    typealias T = AppModelTests

    @Test func savedConnectionsAreTheServersWithATokenInListOrder() {
        let m = T.model(T.saved([T.mac, T.mini], tokens: ["srv-b": "tb"]))
        m.load()
        #expect(m.savedConnections() == [ActiveServer(server: T.mini, token: "tb")])
        let both = T.model(T.saved([T.mac, T.mini], tokens: ["srv-a": "ta", "srv-b": "tb"]))
        both.load()
        #expect(both.savedConnections().map(\.id) == ["srv-a", "srv-b"])
    }

    @Test func theDeviceIdIsMadeOnceAndKept() {
        let storage = MemoryStorage()
        let id = T.model(storage).deviceId()
        #expect(UUID(uuidString: id) != nil)
        #expect(T.model(storage).deviceId() == id)
        #expect(storage.snapshot[StorageKeys.deviceId] == id)
    }

    @Test func forgettingAServerHandsItOverWhileItsTokenIsStillStored() {
        let storage = T.saved([T.mac, T.mini], tokens: ["srv-a": "ta", "srv-b": "tb"])
        let m = T.model(storage)
        m.load()
        var seen: [(ActiveServer, String?)] = []
        m.willForget = { s in seen.append((s, storage.snapshot[StorageKeys.token(s.id)])) }
        m.forget("srv-b")
        #expect(seen.count == 1)
        #expect(seen.first?.0 == ActiveServer(server: T.mini, token: "tb"))
        #expect(seen.first?.1 == "tb")
        #expect(storage.snapshot[StorageKeys.token("srv-b")] == nil)
        // A server without a token has nothing to unregister with.
        m.forget("gone")
        #expect(seen.count == 1)
    }
}
