// HarnessKit: everything in the native app that doesn't draw. Subfolders:
//   Protocol/  Codable ports of shared/src/protocol.ts (wire types, request bodies, events)
//   Client/    HarnessClient (REST) and HarnessSocket (WebSocket), ports of shared/src/client.ts
//   Logic/     pure helpers, ported from shared/ (fixture-checked against TS) or written for the app
//   State/     @Observable app state (later tickets)
// See ios/ARCHITECTURE.md.

public enum HarnessKit {
    /// The `client` name sent in the WebSocket hello.
    public static let clientName = "harness-ios"
}
