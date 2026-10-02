import Foundation
import JavaScriptCore
import Testing
@testable import HarnessKit

private let SERVICE = "http://100.64.1.2:7717" // Tailscale address, not on the SDK's localhost allowlist

/// A page inside the web view, in JavaScriptCore: window.postMessage dispatches a message event
/// (synchronously here) with source = window and origin = location.origin, dropping it when
/// targetOrigin doesn't match. Scripts run as
/// `new Function("window", "location", script)(window, location)`.
private final class FakePage {
    let ctx = JSContext()!
    var toHost: [String] = []

    init(url: String) {
        let origin = PluginBridge.origin(of: url)!
        let forward: @convention(block) (String) -> Void = { [unowned self] in self.toHost.append($0) }
        ctx.setObject(forward, forKeyedSubscript: "__toHost" as NSString)
        ctx.evaluateScript("""
        var location = { origin: \(PluginHost.jsonStringify(.string(origin))) };
        var received = [];
        var selfPosts = [];
        var listeners = [];
        var window = {
          webkit: { messageHandlers: { harness: { postMessage: function (s) { __toHost(s); } } } },
          addEventListener: function (t, l) { listeners.push(l); },
          postMessage: function (message, targetOrigin) {
            selfPosts.push(targetOrigin);
            if (targetOrigin !== "*" && targetOrigin !== location.origin) return;
            var data = JSON.parse(JSON.stringify(message));
            listeners.forEach(function (l) { l({ data: data, origin: location.origin, source: window }); });
          }
        };
        window.addEventListener("message", function (e) { received.push(e.data); });
        """)
        #expect(ctx.exception == nil)
    }

    func run(_ script: String) {
        ctx.setObject(script, forKeyedSubscript: "__script" as NSString)
        ctx.evaluateScript("new Function('window', 'location', __script)(window, location)")
        #expect(ctx.exception == nil, "\(String(describing: ctx.exception))")
    }

    func navigate(to url: String) {
        ctx.evaluateScript("location.origin = \(PluginHost.jsonStringify(.string(PluginBridge.origin(of: url)!)))")
    }

    /// Messages the page's listeners received, as JSON.
    var received: [JSONValue] { decode("JSON.stringify(received)") }
    var selfPosts: [String] { decode("JSON.stringify(selfPosts)") }
    var pwned: Bool { ctx.evaluateScript("typeof globalThis.pwned !== 'undefined'").toBool() }

    private func decode<T: Decodable>(_ expr: String) -> T {
        try! JSONDecoder().decode(T.self, from: Data(ctx.evaluateScript(expr).toString().utf8))
    }
}

private let hostileToken = "a\"b'c\\d\ne\r\u{2028}f\u{2029}g</script><script>globalThis.pwned=1</script>`${x}`"

// MARK: - The host bridge against a JavaScriptCore page

@Suite("PluginHost bridge")
struct PluginHostTests {
    @Test func deliversTheExactMessageEvenWithQuotesBackslashesNewlinesLineSeparatorsAndScriptTags() {
        let msg: JSONValue = .object(["type": .string("harness:init"), "token": .string(hostileToken), "nested": .object(["list": .array([.number(1), .null, .string("\u{0}")])])])
        let script = PluginHost.buildInjection(msg, targetOrigin: SERVICE)
        #expect(!script.unicodeScalars.contains { ["\u{2028}", "\u{2029}", "\n", "\r"].contains($0) })
        #expect(script.hasSuffix("true;"))
        let page = FakePage(url: "\(SERVICE)/plugins/git/ui/index.html")
        page.run(script)
        #expect(page.received == [msg])
        #expect(page.selfPosts == [SERVICE])
        #expect(page.pwned == false)
    }

    @Test func doesNothingWhenThePageIsAtAnotherOrigin() {
        let page = FakePage(url: "https://evil.example/")
        page.run(PluginHost.buildInjection(.object(["type": .string("harness:init"), "token": .string("secret")]), targetOrigin: SERVICE))
        #expect(page.selfPosts == [])
        #expect(page.received == [])
    }

    @Test func anOriginStringCantBreakOutOfTheGuard() {
        let page = FakePage(url: "https://evil.example/")
        page.run(PluginHost.buildInjection(.object(["token": .string("secret")]), targetOrigin: "x\" || true || \""))
        #expect(page.selfPosts == [])
    }

    @Test func messageEventParsesDataAndTakesTheOriginOfThePageUrl() throws {
        let frame = PluginHost.WebViewFrame { _ in }
        let e = try #require(PluginHost.messageEvent(data: #"{"type":"harness:ready"}"#, url: "\(SERVICE)/plugins/git/ui/index.html?tab=changes", source: frame))
        #expect(e.data == .object(["type": .string("harness:ready")]))
        #expect(e.origin == SERVICE)
        #expect(e.source === frame)
    }

    @Test func messageEventIsNilOnBadJsonOrABadUrl() {
        #expect(PluginHost.messageEvent(data: "{nope", url: SERVICE, source: nil) == nil)
        #expect(PluginHost.messageEvent(data: "{}", url: "not a url", source: nil) == nil)
    }
}

// MARK: - End to end: PluginHostBridge ↔ WebViewFrame ↔ a JS page (the SDK side is plugins/sdk; its
// detection of window.ReactNativeWebView, a name kept from the 1.x React Native app, is stood in for
// by nativeBridgeScript)

private final class EndToEnd {
    let page: FakePage
    var injected: [String] = []
    var navigated: [String] = []
    var opened: [String] = []
    var accepted: [Bool] = []
    var theme: PluginBridge.HostTheme = .appearance(.dark)
    var frame: PluginHost.WebViewFrame!
    var bridge: PluginHostBridge!

    init() {
        page = FakePage(url: PluginBridge.pluginUiUrl(baseUrl: SERVICE, pluginId: "git", tabId: "changes"))
        frame = PluginHost.WebViewFrame { [unowned self] script in
            injected.append(script)
            page.run(script)
        }
        bridge = PluginHostBridge(.init(
            baseUrl: "\(SERVICE)/", token: "tok\"en\\with\nstuff", ticketKey: "HELLO-1", tabId: "changes",
            frame: { [unowned self] in frame }, theme: { [unowned self] in theme },
            onNavigate: { [unowned self] in navigated.append($0) }, onOpenExternal: { [unowned self] in opened.append($0) }
        ))
        page.run(PluginHost.nativeBridgeScript(handler: "harness"))
    }

    /// The plugin posting to the host, then the host's WKScriptMessageHandler (url = the page's current URL).
    func pluginSends(_ json: String, pageUrl: String) {
        page.ctx.setObject(json, forKeyedSubscript: "__msg" as NSString)
        page.ctx.evaluateScript("window.ReactNativeWebView.postMessage(__msg)")
        let data = page.toHost.removeLast()
        let e = PluginHost.messageEvent(data: data, url: pageUrl, source: frame)
        accepted.append(e.map { bridge.onMessage($0) } ?? false)
    }
}

@Suite("PluginHost end to end")
struct PluginHostEndToEndTests {
    @Test func initThemeAndTicketReachThePage_navigateAndOpenExternalReachTheHost() {
        let s = EndToEnd()
        let pageUrl = "\(SERVICE)/plugins/git/ui/index.html?tab=changes"
        s.pluginSends(#"{"type":"harness:ready"}"#, pageUrl: pageUrl)
        #expect(s.accepted == [true])
        let initMsg = s.page.received.last
        #expect(initMsg?["type"]?.stringValue == "harness:init")
        #expect(initMsg?["token"]?.stringValue == "tok\"en\\with\nstuff")
        #expect(initMsg?["baseUrl"]?.stringValue == SERVICE)
        #expect(initMsg?["theme"]?.stringValue == "dark")

        s.bridge.sendTheme(.appearance(.light))
        let ticket = Ticket(id: "t", key: "HELLO-1", projectId: "p", title: "T", spec: "", status: .done, sessionId: "s", driver: "d", createdAt: 0, updatedAt: 0)
        s.bridge.sendTicket(ticket)
        var other = ticket
        other.key = "OTHER-2"
        s.bridge.sendTicket(other) // filtered by the host
        #expect(s.page.received.dropFirst().map { $0["type"]?.stringValue } == ["harness:theme", "harness:ticket"])
        #expect(s.page.received.last?["ticket"]?["key"]?.stringValue == "HELLO-1")

        s.pluginSends(#"{"type":"harness:navigate","ticketKey":"OTHER-2"}"#, pageUrl: pageUrl)
        s.pluginSends(#"{"type":"harness:openExternal","url":"https://example.com/x"}"#, pageUrl: pageUrl)
        s.pluginSends(#"{"type":"harness:openExternal","url":"javascript:alert(1)"}"#, pageUrl: pageUrl) // refused
        #expect(s.navigated == ["OTHER-2"])
        #expect(s.opened == ["https://example.com/x"])
        #expect(s.accepted == [true, true, true, false])
    }

    @Test func afterThePageNavigatesAwayInitIsNotDeliveredAndItsMessagesAreRefused() {
        let s = EndToEnd()
        s.bridge.onLoad()
        #expect(s.page.received.count == 1)
        s.page.navigate(to: "https://evil.example/phish")
        let postsBefore = s.page.selfPosts.count
        let injectedBefore = s.injected.count
        s.bridge.onLoad() // host re-offers init on load
        #expect(s.injected.count == injectedBefore + 1) // the host did try…
        #expect(s.page.selfPosts.count == postsBefore) // …but the guard stopped window.postMessage
        #expect(s.page.received.count == 1)

        s.pluginSends(#"{"type":"harness:navigate","ticketKey":"OTHER-3"}"#, pageUrl: "https://evil.example/phish")
        s.pluginSends(#"{"type":"harness:ready"}"#, pageUrl: "https://evil.example/phish")
        #expect(s.navigated == [])
        #expect(s.accepted == [false, false])
        #expect(s.injected.count == injectedBefore + 1) // no init sent in reply to that ready
    }

    @Test func nativeBridgeScriptQuotesTheHandlerName() {
        let page = FakePage(url: SERVICE)
        page.ctx.evaluateScript(#"window.webkit.messageHandlers["a\"b"] = { postMessage: function (s) { __toHost("quoted:" + s); } };"#)
        page.run(PluginHost.nativeBridgeScript(handler: "a\"b"))
        page.ctx.evaluateScript("window.ReactNativeWebView.postMessage(42)")
        #expect(page.toHost == ["quoted:42"]) // String(data): the handler always gets a string
    }
}

// MARK: - Fixtures (Fixtures/pluginHost.json, frozen)

private struct InjectionInput: Decodable, Sendable {
    let msg: JSONValue
    let origin: String
}

private struct BridgeInjectionInput: Decodable, Sendable {
    let theme: String
    let token: String
}

private struct MessageEventInput: Decodable, Sendable {
    let data: String
    let url: String
}

private struct MessageEventOutput: Decodable, Sendable, Equatable {
    let data: JSONValue
    let origin: String

    enum CodingKeys: String, CodingKey { case data, origin }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        data = try c.decode(JSONValue.self, forKey: .data)
        origin = try c.decode(String.self, forKey: .origin)
    }
}

@Suite("PluginHost fixtures")
struct PluginHostFixtureTests {
    @Test(arguments: Fixture.cases("pluginHost", "injectionCases", input: InjectionInput.self, output: String.self))
    fileprivate func injection(_ c: Fixture.Case<InjectionInput, String>) {
        #expect(PluginHost.buildInjection(c.input.msg, targetOrigin: c.input.origin) == c.output)
    }

    /// The bridge's own messages (init with a full theme, theme, a full Ticket) through
    /// WebViewFrame come out byte-identical to the fixture's buildInjection output.
    @Test(arguments: Fixture.cases("pluginHost", "bridgeInjectionCases", input: BridgeInjectionInput.self, output: [String].self))
    fileprivate func bridgeInjection(_ c: Fixture.Case<BridgeInjectionInput, [String]>) throws {
        let sample = try Fixture.value("protocol", "Ticket", as: [Ticket].self)[0]
        var scripts: [String] = []
        let frame = PluginHost.WebViewFrame { scripts.append($0) }
        let theme: PluginBridge.HostTheme = ["light", "dark"].contains(c.input.theme) ? .appearance(Appearance(rawValue: c.input.theme)) : .full(Themes.find(c.input.theme)!.pluginInfo)
        let bridge = try #require(PluginHostBridge(.init(
            baseUrl: "\(SERVICE)/", token: c.input.token, ticketKey: "NYTIMES-31", tabId: "changes",
            frame: { frame }, theme: { theme }, onNavigate: { _ in }, onOpenExternal: { _ in }
        )))
        bridge.onLoad()
        bridge.sendTheme(.appearance(.light))
        bridge.sendTicket(sample)
        #expect(scripts.count == c.output.count)
        for (got, want) in zip(scripts, c.output) { #expect(got == want) }
    }

    @Test(arguments: Fixture.cases("pluginHost", "messageEventCases", input: MessageEventInput.self, output: MessageEventOutput?.self))
    fileprivate func messageEvent(_ c: Fixture.Case<MessageEventInput, MessageEventOutput?>) {
        let e = PluginHost.messageEvent(data: c.input.data, url: c.input.url, source: nil)
        #expect(e?.data == c.output?.data)
        #expect(e?.origin == c.output?.origin)
        #expect((e == nil) == (c.output == nil))
    }
}
