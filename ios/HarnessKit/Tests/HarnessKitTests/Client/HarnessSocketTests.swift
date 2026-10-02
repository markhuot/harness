import Foundation
import Testing
@testable import HarnessKit

private let hello = ClientMessage.hello(client: "harness-ios")

/// A socket on scripted connections and a manual sleep.
private func socket(_ factory: FakeSocketFactory, _ sleep: ManualSleep, baseUrl: String = "http://127.0.0.1:7717", token: String = "tok") -> HarnessSocket {
    HarnessClient(baseUrl: baseUrl, token: token, transport: FakeTransport()).connect(factory: factory.factory, sleep: sleep.sleep)
}

private func eventText(_ kindAndFields: String) -> String {
    #"{"type":"event","event":\#(kindAndFields)}"#
}

@Suite("HarnessSocket")
struct HarnessSocketTests {
    @Test func wsURLAndSchemeMapping() async {
        let plain = HarnessClient(baseUrl: "http://127.0.0.1:7717/", token: "a b&c")
        #expect(plain.socketUrl == "ws://127.0.0.1:7717/ws?token=a%20b%26c")
        let tls = HarnessClient(baseUrl: "https://mac.tail1234.ts.net", token: "t")
        #expect(tls.socketUrl == "wss://mac.tail1234.ts.net/ws?token=t")

        let factory = FakeSocketFactory([FakeConnection()])
        let s = socket(factory, ManualSleep(), baseUrl: "https://h.local:8443", token: "x/y")
        await eventually("connection made") { factory.urls.count == 1 }
        #expect(factory.urls.first?.absoluteString == "wss://h.local:8443/ws?token=x%2Fy")
        await s.close()
    }

    @Test func helloIsTheFirstFrameAndExact() async throws {
        let c = FakeConnection()
        let s = socket(FakeSocketFactory([c]), ManualSleep())
        await eventually("hello sent") { c.sent.count == 1 }
        #expect(try jsonEqual(Data(c.sent[0].utf8), Data(#"{"type":"hello","client":"harness-ios"}"#.utf8)))
        await s.close()
    }

    @Test func helloThenResubscribeOnEveryReconnect() async {
        let c1 = FakeConnection(), c2 = FakeConnection(), c3 = FakeConnection()
        let sleep = ManualSleep()
        let s = socket(FakeSocketFactory([c1, c2, c3]), sleep)
        let status = Recorder(s.status)

        await eventually("first open") { status.items == [true] }
        await s.subscribeBrowser("ses_1")
        await s.subscribeBrowser("ses_2")
        await s.subscribeBrowser("ses_1") // already remembered: sent again, not re-remembered
        #expect(c1.sentMessages == [hello, .browserSubscribe(sessionId: "ses_1"), .browserSubscribe(sessionId: "ses_2"), .browserSubscribe(sessionId: "ses_1")])

        c1.drop()
        await eventually("sleeping after drop") { sleep.pending == 1 }
        sleep.advance()
        await eventually("second open") { status.items == [true, false, true] }
        #expect(c2.sentMessages == [hello, .browserSubscribe(sessionId: "ses_1"), .browserSubscribe(sessionId: "ses_2")])

        await s.unsubscribeBrowser("ses_1")
        #expect(c2.sentMessages.last == .browserUnsubscribe(sessionId: "ses_1"))

        c2.drop()
        await eventually("sleeping after second drop") { sleep.pending == 1 }
        sleep.advance()
        await eventually("third open") { status.items == [true, false, true, false, true] }
        #expect(c3.sentMessages == [hello, .browserSubscribe(sessionId: "ses_2")])
        await s.close()
    }

    @Test func resubscribeReturnsToTheLastTab() async {
        let c1 = FakeConnection(), c2 = FakeConnection(), c3 = FakeConnection()
        let sleep = ManualSleep()
        let s = socket(FakeSocketFactory([c1, c2, c3]), sleep)
        let status = Recorder(s.status)
        let events = Recorder(s.events)
        await eventually("first open") { status.items == [true] }

        await s.subscribeBrowser("ses_1", tabId: 2)
        await s.subscribeBrowser("ses_2")
        await s.subscribeBrowser("ses_1", tabId: 3) // a switch: still one subscription, now on 3
        #expect(c1.sentMessages == [
            hello, .browserSubscribe(sessionId: "ses_1", tabId: 2), .browserSubscribe(sessionId: "ses_2"),
            .browserSubscribe(sessionId: "ses_1", tabId: 3),
        ])

        // The service moved ses_2 to a new tab (newTab) and says so; a state for a session this
        // socket doesn't watch changes nothing.
        c1.push(eventText(#"{"kind":"browser.state","sessionId":"ses_2","state":{"sessionId":"ses_2","tabId":5,"url":"about:blank","title":"","loading":false}}"#))
        c1.push(eventText(#"{"kind":"browser.state","sessionId":"ses_9","state":{"sessionId":"ses_9","tabId":1,"url":"about:blank","title":"","loading":false}}"#))
        await eventually("states seen") { events.items.count == 2 }
        #expect(await s.browserSubscriptions.map { "\($0.sessionId)#\($0.tabId ?? 0)" } == ["ses_1#3", "ses_2#5"])

        c1.drop()
        await eventually("sleeping") { sleep.pending == 1 }
        sleep.advance()
        await eventually("second open") { status.items == [true, false, true] }
        #expect(c2.sentMessages == [hello, .browserSubscribe(sessionId: "ses_1", tabId: 3), .browserSubscribe(sessionId: "ses_2", tabId: 5)])

        // A service without tabs answers with no tabId: forget the tab rather than keep a stale one.
        c2.push(eventText(#"{"kind":"browser.state","sessionId":"ses_1","state":{"sessionId":"ses_1","url":"about:blank","title":"","loading":false}}"#))
        await eventually("third state") { events.items.count == 3 }
        await s.noteBrowserTab("ses_9", tabId: 4) // not subscribed: not remembered
        c2.drop()
        await eventually("sleeping again") { sleep.pending == 1 }
        sleep.advance()
        await eventually("third open") { status.items == [true, false, true, false, true] }
        #expect(c3.sentMessages == [hello, .browserSubscribe(sessionId: "ses_1"), .browserSubscribe(sessionId: "ses_2", tabId: 5)])
        await s.close()
    }

    @Test func tabIdsAreOnTheWireOnlyWhenSet() async throws {
        let c = FakeConnection()
        let s = socket(FakeSocketFactory([c]), ManualSleep())
        await eventually("hello sent") { c.sent.count == 1 }
        await s.subscribeBrowser("ses_1")
        await s.subscribeBrowser("ses_1", tabId: 2)
        await s.send(.browserInput(sessionId: "ses_1", tabId: 2, input: .closeTab))
        await s.send(.browserInput(sessionId: "ses_1", input: .newTab(url: nil)))
        await eventually("all sent") { c.sent.count == 5 }
        let expected = [
            #"{"type":"browser.subscribe","sessionId":"ses_1"}"#,
            #"{"type":"browser.subscribe","sessionId":"ses_1","tabId":2}"#,
            #"{"type":"browser.input","sessionId":"ses_1","tabId":2,"input":{"type":"closeTab"}}"#,
            #"{"type":"browser.input","sessionId":"ses_1","input":{"type":"newTab"}}"#,
        ]
        for (sent, want) in zip(c.sent.dropFirst(), expected) {
            #expect(try jsonEqual(Data(sent.utf8), Data(want.utf8)), "\(sent)")
        }
        await s.close()
    }

    @Test func backoffDoublesToTheCapAcrossFailures() async {
        let factory = FakeSocketFactory() // every attempt is refused
        let sleep = ManualSleep()
        let s = socket(factory, sleep)
        for n in 1...8 {
            await eventually("sleep \(n)") { sleep.requested.count == n && sleep.pending == 1 }
            sleep.advance()
        }
        await eventually("ninth attempt") { factory.made.count == 9 }
        #expect(Array(sleep.requested.prefix(8)) == [
            .milliseconds(250), .milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(5), .seconds(5), .seconds(5),
        ])
        await s.close()
    }

    @Test func backoffResetsAfterASuccessfulOpenAndStatusOnlyOnTransitions() async {
        let ok1 = FakeConnection(), ok2 = FakeConnection()
        let factory = FakeSocketFactory([FakeConnection(refuse: true), FakeConnection(refuse: true), ok1, FakeConnection(refuse: true), ok2])
        let sleep = ManualSleep()
        let s = socket(factory, sleep)
        let status = Recorder(s.status)

        // Two refusals while never connected: no status at all.
        for n in 1...2 {
            await eventually("refusal sleep \(n)") { sleep.requested.count == n && sleep.pending == 1 }
            #expect(status.items.isEmpty)
            sleep.advance()
        }
        await eventually("open") { status.items == [true] }
        #expect(await s.isConnected)

        ok1.drop()
        await eventually("sleep after drop") { sleep.requested.count == 3 && sleep.pending == 1 }
        #expect(status.items == [true, false])
        sleep.advance()
        // Refused again while down: still just one false.
        await eventually("sleep after refusal") { sleep.requested.count == 4 && sleep.pending == 1 }
        #expect(status.items == [true, false])
        sleep.advance()
        await eventually("reopen") { status.items == [true, false, true] }

        #expect(sleep.requested == [.milliseconds(250), .milliseconds(500), .milliseconds(250), .milliseconds(500)])

        await s.close()
        await eventually("status finished") { status.finished }
        #expect(status.items == [true, false, true, false])
        #expect(ok2.closeCalls >= 1)
    }

    @Test func closeDuringSleepStopsReconnecting() async {
        let factory = FakeSocketFactory()
        let sleep = ManualSleep()
        let s = socket(factory, sleep)
        let events = Recorder(s.events)
        let status = Recorder(s.status)
        await eventually("sleeping") { sleep.pending == 1 }

        await s.close()
        await eventually("streams finished") { events.finished && status.finished }
        #expect(sleep.cancellations == 1)
        #expect(sleep.pending == 0)
        #expect(factory.made.count == 1)
        #expect(status.items.isEmpty)
    }

    @Test func closeWhileOpenClosesTheConnectionAndDoesNotReconnect() async {
        let c = FakeConnection()
        let factory = FakeSocketFactory([c, FakeConnection()])
        let sleep = ManualSleep()
        let s = socket(factory, sleep)
        let status = Recorder(s.status)
        await eventually("open") { status.items == [true] }
        await s.close()
        await eventually("finished") { status.finished }
        #expect(c.closeCalls >= 1)
        #expect(sleep.requested.isEmpty)
        #expect(factory.made.count == 1)
    }

    @Test func onlyEventMessagesAreEmittedAndBadFramesSkipped() async throws {
        let c = FakeConnection()
        let s = socket(FakeSocketFactory([c]), ManualSleep())
        let events = Recorder(s.events)
        let status = Recorder(s.status)
        await eventually("open") { status.items == [true] }

        c.push(#"{"type":"welcome","version":"0.9.0"}"#)
        c.push("not json at all")
        c.push(#"{"type":"pong"}"#)
        c.push(#"{"type":"error","message":"browser.subscribe failed"}"#)
        c.push(eventText(#"{"kind":"ticket.deleted","id":"tkt_1"}"#))
        c.push(eventText(#"{"kind":"ticket.upserted"}"#)) // malformed: no ticket
        c.push(#"{"no":"type"}"#)
        c.push(.data(Data(eventText(#"{"kind":"project.deleted","id":"prj_1"}"#).utf8)))
        c.push(eventText(#"{"kind":"future.kind","x":1}"#))

        await eventually("three events") { events.items.count == 3 }
        #expect(events.items[0] == .ticketDeleted(id: "tkt_1"))
        #expect(events.items[1] == .projectDeleted(id: "prj_1"))
        #expect(events.items[2].kind == "future.kind")
        // Still the same open connection: bad frames weren't fatal.
        #expect(status.items == [true])
        #expect(await s.isConnected)
        await s.close()
    }

    @Test func sendBeforeTheHandshakeCompletesIsDropped() async {
        let c = FakeConnection(holdHandshake: true)
        let s = socket(FakeSocketFactory([c]), ManualSleep())
        let status = Recorder(s.status)
        await eventually("handshake in flight") { c.handshakeWaiting }
        // The connection exists but isn't open: this ping must not reach it (or overtake the hello).
        let ping = Task { await s.send(.ping) }
        await ping.value
        c.completeHandshake()
        await eventually("open") { status.items == [true] }
        #expect(c.sentMessages == [hello])
        await s.close()
    }

    @Test func sendWhileDisconnectedIsDroppedNotQueued() async {
        let c1 = FakeConnection(), c2 = FakeConnection()
        let sleep = ManualSleep()
        let s = socket(FakeSocketFactory([c1, c2]), sleep)
        let status = Recorder(s.status)
        await eventually("open") { status.items == [true] }
        await s.send(.ping)
        #expect(c1.sentMessages == [hello, .ping])

        c1.drop()
        await eventually("down") { sleep.pending == 1 }
        await s.send(.ping)
        await s.subscribeBrowser("ses_9") // remembered even though the send is dropped
        #expect(c1.sentMessages == [hello, .ping])
        sleep.advance()
        await eventually("reopen") { status.items == [true, false, true] }
        #expect(c2.sentMessages == [hello, .browserSubscribe(sessionId: "ses_9")])
        await s.close()
    }
}
