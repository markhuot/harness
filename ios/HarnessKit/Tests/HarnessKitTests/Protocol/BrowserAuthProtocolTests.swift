import Foundation
import Testing
@testable import HarnessKit

private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(text.utf8))
}

/// HTTP Basic Auth on the wire (shared/src/protocol.ts BrowserAuth, the `auth` and `authCancel` inputs).
@Suite("Browser auth protocol")
struct BrowserAuthProtocolTests {
    @Test func stateCarriesThePendingChallenge() throws {
        let raw = #"{"sessionId":"s","url":"https://x/","title":"","loading":false,"auth":{"origin":"https://x","realm":"Staging","failed":true}}"#
        let s = try decode(BrowserState.self, raw)
        #expect(s.auth == BrowserAuth(origin: "https://x", realm: "Staging", failed: true))
        #expect(s.auth?.wasRefused == true)
        // From a service that doesn't know the challenge: nothing pending, not refused.
        #expect(try decode(BrowserState.self, #"{"sessionId":"s","url":"u","title":"","loading":false}"#).auth == nil)
        #expect(BrowserAuth(origin: "https://x", realm: "").wasRefused == false)
    }

    @Test func plainTextOriginsAreFlagged() {
        #expect(BrowserAuth(origin: "http://192.168.1.2:8080", realm: "a").isPlainText)
        #expect(!BrowserAuth(origin: "https://example.com", realm: "a").isPlainText)
    }

    @Test func answersEncodeWithTheirFields() throws {
        let sent = String(decoding: try JSONEncoder().encode(BrowserInput.auth(origin: "https://x", realm: "R", username: "alice", password: "p w")), as: UTF8.self)
        #expect(sent.contains(#""type":"auth""#) && sent.contains(#""username":"alice""#) && sent.contains(#""password":"p w""#))
        #expect(sent.contains(#""origin":"https:\/\/x""#) && sent.contains(#""realm":"R""#))
        #expect(try decode(BrowserInput.self, #"{"type":"authCancel","origin":"o","realm":"r"}"#) == .authCancel(origin: "o", realm: "r"))
        #expect(
            try decode(BrowserInput.self, #"{"type":"auth","origin":"o","realm":"r","username":"a","password":"b"}"#)
                == .auth(origin: "o", realm: "r", username: "a", password: "b"))
    }
}
