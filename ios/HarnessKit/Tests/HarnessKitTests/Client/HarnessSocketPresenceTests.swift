import Foundation
import Testing
@testable import HarnessKit

/// HarnessSocket's `presence`: sent when it changes, not when it doesn't, and again after every
/// reconnect (the service forgets a socket's presence when it closes).
@Suite("HarnessSocket presence")
struct HarnessSocketPresenceTests {
    private let hello = ClientMessage.hello(client: "harness-ios")

    private func socket(_ factory: FakeSocketFactory, _ sleep: ManualSleep) -> HarnessSocket {
        HarnessClient(baseUrl: "http://127.0.0.1:7717", token: "tok", transport: FakeTransport()).connect(factory: factory.factory, sleep: sleep.sleep)
    }

    private func p(_ visible: Bool, _ tickets: [String]) -> Presence {
        Presence(deviceId: "dev-1", platform: .ios, visible: visible, tickets: tickets)
    }

    @Test func presenceIsSentOnChangeOnlyAndReplayedAfterAReconnect() async {
        let c1 = FakeConnection(), c2 = FakeConnection()
        let sleep = ManualSleep()
        let s = socket(FakeSocketFactory([c1, c2]), sleep)
        let status = Recorder(s.status)
        await eventually("first open") { status.items == [true] }

        await s.setPresence(p(true, ["B-2", "A-1", "B-2"]))
        // The same set in another order is not news.
        await s.setPresence(p(true, ["A-1", "B-2"]))
        await s.setPresence(p(false, ["A-1", "B-2"]))
        #expect(c1.sentMessages == [hello, .presence(p(true, ["A-1", "B-2"])), .presence(p(false, ["A-1", "B-2"]))])

        c1.drop()
        await eventually("sleeping after drop") { sleep.pending == 1 }
        // Set while down: not sent now, but it's what the next connection reports.
        await s.setPresence(p(true, ["C-3"]))
        sleep.advance()
        await eventually("second open") { status.items == [true, false, true] }
        #expect(c2.sentMessages == [hello, .presence(p(true, ["C-3"]))])
        await s.close()
    }

    @Test func noPresenceIsSentBeforeOneIsSet() async {
        let c1 = FakeConnection()
        let s = socket(FakeSocketFactory([c1]), ManualSleep())
        let status = Recorder(s.status)
        await eventually("open") { status.items == [true] }
        #expect(c1.sentMessages == [hello])
        await s.close()
    }

    @Test func presenceEncodesFlatWithItsType() throws {
        let data = try JSONEncoder().encode(ClientMessage.presence(p(true, ["A-1"])))
        #expect(try jsonEqual(data, Data(#"{"type":"presence","deviceId":"dev-1","platform":"ios","visible":true,"tickets":["A-1"]}"#.utf8)))
        #expect(try JSONDecoder().decode(ClientMessage.self, from: data) == .presence(p(true, ["A-1"])))
    }
}
