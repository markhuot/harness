import Foundation
import Testing
@testable import HarnessKit

private final class RecordingFrame: PluginFrame {
    var posted: [(message: PluginHostMessage, targetOrigin: String)] = []
    func postMessage(_ message: PluginHostMessage, targetOrigin: String) {
        posted.append((message, targetOrigin))
    }
}

private final class OtherFrame: PluginFrame {
    func postMessage(_ message: PluginHostMessage, targetOrigin: String) {}
}

/// The TS test's `setup()`: a bridge with recording callbacks and a swappable frame/theme.
private final class Harness {
    let frame = RecordingFrame()
    let other = OtherFrame()
    var current: RecordingFrame?
    var theme: PluginBridge.HostTheme
    var navigated: [String] = []
    var opened: [String] = []
    var ready = 0
    let origin = "http://127.0.0.1:7801"
    var bridge: PluginHostBridge!

    init(theme: PluginBridge.HostTheme = .appearance(.light), baseUrl: String = "http://127.0.0.1:7801/", token: String = "secret", ticketKey: String = "HELLO-1", tabId: String = "changes") {
        self.theme = theme
        current = frame
        bridge = PluginHostBridge(.init(
            baseUrl: baseUrl, token: token, ticketKey: ticketKey, tabId: tabId,
            frame: { [unowned self] in self.current },
            theme: { [unowned self] in self.theme },
            onNavigate: { [unowned self] in self.navigated.append($0) },
            onOpenExternal: { [unowned self] in self.opened.append($0) },
            onReady: { [unowned self] in self.ready += 1 }
        ))
    }

    func send(_ data: JSONValue, origin: String? = nil, source: AnyObject? = nil) -> Bool {
        bridge.onMessage(.init(data: data, origin: origin ?? self.origin, source: source ?? frame))
    }
}

private func json(_ m: PluginHostMessage) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(m))
}

/// A JSON object from Swift literals (strings, numbers); keeps the TS test lines readable.
private func msg(_ d: [String: Any]) -> JSONValue {
    .object(d.mapValues { v in
        switch v {
        case let s as String: .string(s)
        case let n as Int: .number(Double(n))
        default: .null
        }
    })
}

private let readyMsg: JSONValue = msg(["type": "harness:ready"])

private func sampleTicket(key: String, busy: Bool = false) -> Ticket {
    Ticket(id: "t", key: key, projectId: "p", title: "T", description: "", status: .planning, sessionId: "s", driver: "claude-code", busy: busy, createdAt: 0, updatedAt: 0)
}

// MARK: - Direct ports of pluginBridge.test.ts

@Suite("pluginBridge.test.ts")
struct PluginBridgeTests {
    @Test func initGoesOnlyToTheServiceOriginOnLoadAndOnEveryReady() {
        let s = Harness(theme: .appearance(.dark))
        #expect(s.bridge.serviceOrigin == s.origin)
        s.bridge.onLoad()
        #expect(s.frame.posted.count == 1)
        #expect(json(s.frame.posted[0].message) == msg([
            "type": "harness:init", "baseUrl": "http://127.0.0.1:7801", "token": "secret", "ticketKey": "HELLO-1", "tabId": "changes", "theme": "dark",
        ]))
        #expect(s.frame.posted[0].targetOrigin == s.origin)
        #expect(s.send(readyMsg) == true)
        #expect(s.send(readyMsg) == true)
        #expect(s.frame.posted.count == 3)
        #expect(s.frame.posted.allSatisfy { $0.targetOrigin == s.origin })
        #expect(s.ready == 1)
    }

    @Test func rejectsMessagesFromOtherWindowsOrOrigins() {
        let s = Harness()
        #expect(s.send(readyMsg, source: s.other) == false)
        #expect(s.send(readyMsg, origin: "https://evil.example") == false)
        #expect(s.send(readyMsg, origin: "http://127.0.0.1:9999") == false)
        #expect(s.send(readyMsg, origin: "null") == false)
        #expect(s.send(.null) == false)
        #expect(s.send(msg(["type": "harness:bogus"])) == false)
        #expect(s.frame.posted.isEmpty)
        s.current = nil
        #expect(s.send(readyMsg) == false)
        #expect(s.ready == 0)
    }

    @Test func openExternalAndNavigateAreValidated() {
        let s = Harness()
        #expect(s.send(msg(["type": "harness:openExternal", "url": "https://github.com/x"])) == true)
        #expect(s.send(msg(["type": "harness:openExternal", "url": "mailto:a@b.c"])) == true)
        #expect(s.send(msg(["type": "harness:openExternal", "url": "file:///etc/passwd"])) == false)
        #expect(s.send(msg(["type": "harness:openExternal", "url": "javascript:alert(1)"])) == false)
        #expect(s.send(msg(["type": "harness:openExternal"])) == false)
        #expect(s.send(msg(["type": "harness:navigate", "ticketKey": "OTHER-12"])) == true)
        #expect(s.send(msg(["type": "harness:navigate", "ticketKey": "../settings"])) == false)
        #expect(s.send(msg(["type": "harness:navigate", "ticketKey": 3])) == false)
        #expect(s.opened == ["https://github.com/x", "mailto:a@b.c"])
        #expect(s.navigated == ["OTHER-12"])
    }

    @Test func themeAndTicketPushes_ticketsForOtherKeysAreDropped() {
        let s = Harness()
        s.bridge.sendTheme(.appearance(.dark))
        s.bridge.sendTicket(sampleTicket(key: "HELLO-1", busy: true))
        s.bridge.sendTicket(sampleTicket(key: "HELLO-2"))
        #expect(s.frame.posted.map(\.message.type) == ["harness:theme", "harness:ticket"])
        #expect(json(s.frame.posted[0].message)["theme"]?.stringValue == "dark")
        s.theme = .appearance(.dark)
        s.bridge.onLoad()
        #expect(json(s.frame.posted.last!.message)["theme"]?.stringValue == "dark") // init reads the theme at send time
    }

    @Test func fullThemeAddsAppearanceIdSyntaxThemeAndTokens() throws {
        let mocha = try #require(Themes.find("catppuccin-mocha")).pluginInfo
        let s = Harness(theme: .full(mocha))
        s.bridge.onLoad()
        let initMsg = json(s.frame.posted[0].message)
        #expect(initMsg["type"]?.stringValue == "harness:init")
        #expect(initMsg["token"]?.stringValue == "secret")
        #expect(initMsg["theme"]?.stringValue == "dark")
        #expect(initMsg["appearance"]?.stringValue == "dark")
        #expect(initMsg["themeId"]?.stringValue == "catppuccin-mocha")
        #expect(initMsg["themeName"]?.stringValue == "Catppuccin Mocha")
        #expect(initMsg["syntaxTheme"]?.stringValue == "catppuccin-mocha")
        #expect(initMsg["tokens"]?["bg"]?.stringValue == mocha.tokens.bg)
        s.bridge.sendTheme(.full(try #require(Themes.find("one-light")).pluginInfo))
        let t = json(s.frame.posted.last!.message)
        #expect(t["type"]?.stringValue == "harness:theme")
        #expect(t["theme"]?.stringValue == "light")
        #expect(t["appearance"]?.stringValue == "light")
        #expect(t["themeId"]?.stringValue == "one-light")
        #expect(t["syntaxTheme"]?.stringValue == "one-light")
        // (The TS "payload is a copy" check has no Swift counterpart: tokens are a value type.)
        // A bare appearance still produces exactly the old message.
        s.bridge.sendTheme(.appearance(.light))
        #expect(json(s.frame.posted.last!.message) == msg(["type": "harness:theme", "theme": "light"]))
    }

    @Test func helpers() {
        #expect(PluginBridge.pluginUiUrl(baseUrl: "http://127.0.0.1:7717/", pluginId: "git", tabId: "changes") == "http://127.0.0.1:7717/plugins/git/ui/index.html?tab=changes")
    }

    // Swift-only: the frame identity check is by object, not by equal values.
    @Test func aDifferentFrameInstanceIsRejectedAfterASwap() {
        let s = Harness()
        let replacement = RecordingFrame()
        let old = s.frame
        s.current = replacement
        #expect(s.send(readyMsg, source: old) == false)
        #expect(s.send(readyMsg, source: replacement) == true)
        #expect(replacement.posted.count == 1)
        #expect(old.posted.isEmpty)
    }

    @Test func invalidBaseUrlHasNoBridge() {
        let opts = PluginHostBridge.Options(
            baseUrl: "not a url", token: "t", ticketKey: "A-1", tabId: "x", frame: { nil }, theme: { .appearance(.light) },
            onNavigate: { _ in }, onOpenExternal: { _ in }
        )
        #expect(PluginHostBridge(opts) == nil)
    }
}

// MARK: - Fixtures computed by the TS implementation

/// "light" / "dark", or a bundled theme by id.
private enum ThemeSpec: Decodable, Sendable {
    case appearance(Appearance)
    case themeId(String)

    init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .appearance(Appearance(rawValue: s)) } else {
            self = .themeId(try c.decode([String: String].self)["themeId"]!)
        }
    }

    var hostTheme: PluginBridge.HostTheme {
        switch self {
        case let .appearance(a): .appearance(a)
        case let .themeId(id): .full(Themes.find(id)!.pluginInfo)
        }
    }
}

private struct BridgeStep: Decodable, Sendable {
    let op: String
    let data: JSONValue?
    let origin: String?
    let source: String?
    let theme: ThemeSpec?
    let ticket: Ticket?

    enum CodingKeys: String, CodingKey { case op, data, origin, source, theme, ticket }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        op = try c.decode(String.self, forKey: .op)
        // A present `data: null` is the JSON null message, not "no data".
        data = c.contains(.data) ? try c.decode(JSONValue.self, forKey: .data) : nil
        origin = try c.decodeIfPresent(String.self, forKey: .origin)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        theme = try c.decodeIfPresent(ThemeSpec.self, forKey: .theme)
        ticket = try c.decodeIfPresent(Ticket.self, forKey: .ticket)
    }
}

private struct BridgeInput: Decodable, Sendable {
    let baseUrl: String
    let token: String
    let ticketKey: String
    let tabId: String
    let theme: ThemeSpec
    let steps: [BridgeStep]
}

private struct Posted: Decodable, Sendable, Equatable {
    let message: JSONValue
    let targetOrigin: String
}

private struct StepResult: Decodable, Sendable, Equatable {
    let accepted: Bool?
    let posted: [Posted]
    let navigated: [String]
    let opened: [String]
    let ready: Int
}

private struct BridgeOutput: Decodable, Sendable {
    let serviceOrigin: String
    let steps: [StepResult]
}

private struct UiUrlInput: Decodable, Sendable {
    let baseUrl: String
    let pluginId: String
    let tabId: String
}

@Suite("pluginBridge.ts parity")
struct PluginBridgeFixtureTests {
    @Test(arguments: Fixture.cases("pluginBridge", "bridgeCases", input: BridgeInput.self, output: BridgeOutput?.self))
    fileprivate func bridge(_ c: Fixture.Case<BridgeInput, BridgeOutput?>) throws {
        let i = c.input
        let s = Harness(theme: i.theme.hostTheme, baseUrl: i.baseUrl, token: i.token, ticketKey: i.ticketKey, tabId: i.tabId)
        guard let expected = c.output else {
            #expect(s.bridge == nil)
            return
        }
        let bridge = try #require(s.bridge)
        #expect(bridge.serviceOrigin == expected.serviceOrigin)
        var results: [StepResult] = []
        for step in i.steps {
            var accepted: Bool?
            let before = (s.frame.posted.count, s.navigated.count, s.opened.count)
            switch step.op {
            case "load": bridge.onLoad()
            case "message":
                let source: AnyObject? = switch step.source {
                case "frame": s.frame
                case "other": s.other
                default: nil
                }
                accepted = bridge.onMessage(.init(data: step.data!, origin: step.origin!, source: source))
            case "sendTheme": bridge.sendTheme(step.theme!.hostTheme)
            case "sendTicket": bridge.sendTicket(step.ticket!)
            case "setTheme": s.theme = step.theme!.hostTheme
            case "detach": s.current = nil
            case "attach": s.current = s.frame
            default: Issue.record("unknown op \(step.op)")
            }
            results.append(StepResult(
                accepted: accepted,
                posted: s.frame.posted[before.0...].map { Posted(message: json($0.message), targetOrigin: $0.targetOrigin) },
                navigated: Array(s.navigated[before.1...]),
                opened: Array(s.opened[before.2...]),
                ready: s.ready
            ))
        }
        #expect(results.count == expected.steps.count)
        for (n, (got, want)) in zip(results, expected.steps).enumerated() {
            #expect(got == want, "step \(n): \(i.steps[n].op)")
        }
    }

    @Test(arguments: Fixture.cases("pluginBridge", "originCases", input: String.self, output: String?.self))
    func origin(_ c: Fixture.Case<String, String?>) {
        #expect(PluginBridge.origin(of: c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("pluginBridge", "pluginUiUrlCases", input: UiUrlInput.self, output: String.self))
    fileprivate func pluginUiUrl(_ c: Fixture.Case<UiUrlInput, String>) {
        #expect(PluginBridge.pluginUiUrl(baseUrl: c.input.baseUrl, pluginId: c.input.pluginId, tabId: c.input.tabId) == c.output)
    }

    @Test(arguments: Fixture.cases("pluginBridge", "themeFieldsCases", input: ThemeSpec.self, output: JSONValue.self))
    fileprivate func themeFields(_ c: Fixture.Case<ThemeSpec, JSONValue>) throws {
        // The TS returns `{ theme, ...fields }`; a harness:theme message is exactly that plus `type`.
        let (theme, fields) = PluginBridge.themeFields(c.input.hostTheme)
        guard case var .object(got) = json(.theme(theme, fields)) else { Issue.record("not an object"); return }
        got["type"] = nil
        #expect(JSONValue.object(got) == c.output)
    }
}
