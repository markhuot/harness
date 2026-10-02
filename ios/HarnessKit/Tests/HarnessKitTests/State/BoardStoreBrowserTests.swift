import Foundation
import Synchronization
import Testing
@testable import HarnessKit

/// BoardStore's outgoing browser channel (the Browser tab's subscribe / input path).
@MainActor
@Suite("BoardStore browser channel")
struct BoardStoreBrowserTests {
    /// An EventSource that is also a BrowserChannel and logs what reaches it. Each send suspends
    /// for a moment, so out-of-order delivery would show.
    final class ChannelSocket: EventSource, BrowserChannel {
        let events: AsyncStream<HarnessEvent>
        let status: AsyncStream<Bool>
        private let eventsOut: AsyncStream<HarnessEvent>.Continuation
        private let statusOut: AsyncStream<Bool>.Continuation
        let log = CallLog<String>()

        init() {
            (events, eventsOut) = AsyncStream.makeStream()
            (status, statusOut) = AsyncStream.makeStream()
        }

        func send(_ msg: ClientMessage) async {
            try? await Task.sleep(for: .milliseconds(Int.random(in: 0...3)))
            guard case let .browserInput(sessionId, tabId, input) = msg else { return log.append("other \(msg.type)") }
            log.append("\(sessionId)\(tabId.map { "#\($0)" } ?? "") \(Self.describe(input))")
        }

        func subscribeBrowser(_ sessionId: String, tabId: Int?) async {
            log.append("subscribe \(sessionId)\(tabId.map { "#\($0)" } ?? "")")
        }
        func unsubscribeBrowser(_ sessionId: String) async { log.append("unsubscribe \(sessionId)") }

        func close() async {
            eventsOut.finish()
            statusOut.finish()
        }

        static func describe(_ input: BrowserInput) -> String {
            switch input {
            case let .mouse(m): "mouse \(m.action.rawValue) \(Int(m.x)),\(Int(m.y))"
            case let .text(t): "text \(t)"
            default: input.type
            }
        }
    }

    @MainActor
    final class Rig {
        var sockets: [ChannelSocket] = []
        var store: BoardStore!

        init() {
            store = BoardStore(client: BoardStoreTests.FakeClient(), baseUrl: "http://mac:7717", makeSocket: { [unowned self] in
                let s = ChannelSocket()
                self.sockets.append(s)
                return s
            }, timers: ManualTimers())
        }
    }

    @Test func inputKeepsItsOrderAndCarriesTheSession() async {
        let r = Rig()
        r.store.start()
        r.store.subscribeBrowser("s1")
        for i in 0..<20 { r.store.sendBrowserInput("s1", .mouse(.init(action: .move, x: Double(i), y: 0))) }
        r.store.sendBrowserInput("s1", .text(text: "hi"))
        r.store.unsubscribeBrowser("s1")
        let socket = r.sockets[0]
        #expect(await eventually { socket.log.all.count == 23 })
        #expect(socket.log.all == ["subscribe s1"] + (0..<20).map { "s1 mouse move \($0),0" } + ["s1 text hi", "unsubscribe s1"])
    }

    @Test func tabIdsRideAlongOnSubscribeAndInput() async {
        let r = Rig()
        r.store.start()
        r.store.subscribeBrowser("s1", tabId: 2)
        r.store.sendBrowserInput("s1", tabId: 3, .closeTab)
        r.store.sendBrowserInput("s1", .newTab(url: nil))
        r.store.subscribeBrowser("s1")
        let socket = r.sockets[0]
        #expect(await eventually { socket.log.all.count == 4 })
        #expect(socket.log.all == ["subscribe s1#2", "s1#3 closeTab", "s1 newTab", "subscribe s1"])
    }

    @Test func nothingIsSentBeforeStart() async {
        let r = Rig()
        r.store.subscribeBrowser("s1")
        r.store.sendBrowserInput("s1", .reload)
        r.store.start()
        r.store.sendBrowserInput("s1", .back)
        #expect(await eventually { r.sockets[0].log.all.count == 1 })
        #expect(r.sockets[0].log.all == ["s1 back"])
    }

    @Test func aRebuiltSocketBumpsTheGenerationAndTakesNewMessages() async {
        let r = Rig()
        r.store.start()
        #expect(r.store.socketGeneration == 1)
        r.store.sceneDidEnterBackground()
        r.store.sceneBecameActive() // disconnected: the socket is rebuilt
        #expect(r.sockets.count == 2)
        #expect(r.store.socketGeneration == 2)
        r.store.subscribeBrowser("s1")
        #expect(await eventually { r.sockets[1].log.all == ["subscribe s1"] })
        #expect(r.sockets[0].log.all.isEmpty)
    }

    @Test func closeDropsLaterMessages() async {
        let r = Rig()
        r.store.start()
        r.store.close()
        r.store.sendBrowserInput("s1", .reload)
        try? await Task.sleep(for: .milliseconds(30))
        #expect(r.sockets[0].log.all.isEmpty)
    }
}
