import Foundation
import Testing
@testable import HarnessKit

@Suite("Plugin tab WebView policy (PluginTab.tsx)")
struct PluginWebPolicyTests {
    static let origin = "http://127.0.0.1:7717"

    @Test(arguments: [
        ("http://127.0.0.1:7717/plugins/git/ui/index.html?tab=changes", PluginHost.NavigationPolicy.allow),
        ("http://127.0.0.1:7717", .allow),
        ("about:blank", .allow),
        // Not the service origin, even though they start with its text.
        ("http://127.0.0.1:77170/x", .openExternally),
        ("http://127.0.0.1:7717.evil.example/x", .openExternally),
        ("http://127.0.0.1:7717@evil.example/", .openExternally),
        ("https://127.0.0.1:7717/x", .openExternally),
        ("HTTPS://github.com/markhuot/harness", .openExternally),
        ("Mailto:someone@example.com", .openExternally),
        ("javascript:alert(1)", .deny),
        ("tel:5551234", .deny),
        ("about:srcdoc", .deny),
        ("harness://ticket/GREET-1", .deny),
        ("", .deny),
    ])
    func navigation(url: String, expected: PluginHost.NavigationPolicy) {
        #expect(PluginHost.navigationPolicy(url: url, serviceOrigin: Self.origin) == expected)
    }

    final class Frame: PluginFrame {
        func postMessage(_ message: PluginHostMessage, targetOrigin: String) {}
    }

    @Test func mainFrameStringMessagesBecomeEventsFromTheFrame() throws {
        let frame = Frame()
        let e = try #require(PluginHost.scriptMessageEvent(
            body: #"{"type":"harness:ready"}"#, frameURL: URL(string: "http://127.0.0.1:7717/plugins/git/ui/index.html"), isMainFrame: true, source: frame))
        #expect(e.origin == Self.origin)
        #expect(e.source === frame)
        #expect(e.data["type"] == .string("harness:ready"))
    }

    @Test func subframeNonStringAndUrlLessMessagesAreDropped() {
        let url = URL(string: "http://127.0.0.1:7717/x")
        #expect(PluginHost.scriptMessageEvent(body: #"{"type":"harness:ready"}"#, frameURL: url, isMainFrame: false, source: nil) == nil)
        #expect(PluginHost.scriptMessageEvent(body: ["type": "harness:ready"], frameURL: url, isMainFrame: true, source: nil) == nil)
        #expect(PluginHost.scriptMessageEvent(body: #"{"type":"harness:ready"}"#, frameURL: nil, isMainFrame: true, source: nil) == nil)
        #expect(PluginHost.scriptMessageEvent(body: "not json", frameURL: url, isMainFrame: true, source: nil) == nil)
    }
}
