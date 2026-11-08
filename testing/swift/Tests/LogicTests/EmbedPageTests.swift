import Foundation
import Testing
import HarnessKit

/// Answers every request with `response`, recording what was sent.
private final class EmbedTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _sent: [HTTPRequest] = []
    let response: HTTPResponse

    init(_ response: HTTPResponse) { self.response = response }

    var sent: [HTTPRequest] { lock.withLock { _sent } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { _sent.append(request) }
        return response
    }
}

/// The iPhone/iPad embed's scheme, navigation, message and lifecycle rules (EmbedPage).
@Suite struct EmbedPageTests {
    private func path(_ s: String) -> String? { EmbedPage.servicePath(URL(string: s)!) }

    @Test func theEntryIsTheIdsRoot() {
        #expect(EmbedPage.entryURL("ab12")?.absoluteString == "harness-embed://ab12/")
        #expect(EmbedPage.entryURL("../x") == nil)
        #expect(EmbedPage.entryURL("") == nil)
    }

    @Test func aSchemeURLMapsToTheEmbedsRoute() {
        #expect(path("harness-embed://ab12/") == "/embeds/ab12/")
        #expect(path("harness-embed://ab12/js/app.js?v=3#top") == "/embeds/ab12/js/app.js")
        #expect(path("harness-embed://ab12/data%20set.json") == "/embeds/ab12/data%20set.json")
    }

    @Test func aURLOutsideThePageMapsToNothing() {
        #expect(path("https://ab12/x") == nil)
        #expect(path("harness-embed://ab12/../tickets") == nil)
        #expect(path("harness-embed://ab12/a/%2E%2E/b") == nil)
        #expect(path("harness-embed://-x/") == nil)
    }

    @Test func theMainFrameStaysOnItsOwnPage() {
        #expect(EmbedPage.navigationPolicy(url: "harness-embed://ab12/next.html", id: "ab12", mainFrame: true) == .allow)
        #expect(EmbedPage.navigationPolicy(url: "about:blank", id: "ab12", mainFrame: true) == .allow)
        #expect(EmbedPage.navigationPolicy(url: "https://example.com/", id: "ab12", mainFrame: true) == .openExternally)
        #expect(EmbedPage.navigationPolicy(url: "mailto:a@b.c", id: "ab12", mainFrame: true) == .openExternally)
        // Another page's files, a near-miss id, and script URLs don't load.
        #expect(EmbedPage.navigationPolicy(url: "harness-embed://ab123/", id: "ab12", mainFrame: true) == .deny)
        #expect(EmbedPage.navigationPolicy(url: "harness-embed://cd34/", id: "ab12", mainFrame: true) == .deny)
        #expect(EmbedPage.navigationPolicy(url: "javascript:alert(1)", id: "ab12", mainFrame: true) == .deny)
    }

    @Test func aSubframeMayLoadTheWeb() {
        #expect(EmbedPage.navigationPolicy(url: "https://cdn.example.com/widget", id: "ab12", mainFrame: false) == .allow)
        #expect(EmbedPage.navigationPolicy(url: "about:srcdoc", id: "ab12", mainFrame: false) == .allow)
        #expect(EmbedPage.navigationPolicy(url: "mailto:a@b.c", id: "ab12", mainFrame: false) == .openExternally)
        #expect(EmbedPage.navigationPolicy(url: "harness-embed://cd34/", id: "ab12", mainFrame: false) == .deny)
    }

    @Test func onlyANumberIsAHeight() {
        #expect(EmbedPage.reportedHeight(NSNumber(value: 812.5)) == 812.5)
        #expect(EmbedPage.reportedHeight(NSNumber(value: 640)) == 640)
        #expect(EmbedPage.reportedHeight(NSNumber(value: true)) == nil)
        #expect(EmbedPage.reportedHeight("812") == nil)
        #expect(EmbedPage.reportedHeight(["height": 812]) == nil)
    }

    @Test func thePageSeesItsTypeAndRangeOnly() {
        let out = EmbedPage.pageHeaders([
            "content-type": "text/html", "content-range": "bytes 0-9/100", "content-length": "10",
            "set-cookie": "a=b", "server": "bun", "accept-ranges": "bytes",
        ])
        #expect(out == ["content-type": "text/html", "content-range": "bytes 0-9/100", "accept-ranges": "bytes"])
    }

    @Test func anEmbedLoadsNearTheScreenAndIsReleasedFarFromIt() {
        // A 800 pt viewport at 0…800.
        func live(_ now: Bool, _ top: Double) -> Bool { EmbedPage.live(now, top: top, bottom: top + 360, viewTop: 0, viewBottom: 800) }
        #expect(live(false, 400))           // on screen
        #expect(live(false, 1600))          // a viewport below
        #expect(!live(false, 1700))         // further: not yet
        #expect(live(true, 1700))           // already live: kept
        #expect(live(true, 3200))
        #expect(!live(true, 3300))          // past three viewports: released
        #expect(!live(true, -360 - 2401))   // above the screen too
        #expect(live(true, -360 - 2400))
    }

    @Test func aFileGoesToTheServiceWithTheTokenAndRange() async throws {
        let transport = EmbedTransport(HTTPResponse(status: 206, body: Data("abc".utf8), headers: ["content-type": "text/plain"]))
        let client = HarnessClient(baseUrl: "http://mac.tail:7717", token: "tok", transport: transport)
        let res = try await client.embedFile("/embeds/ab12/data.json", range: "bytes=0-2")
        #expect(res.status == 206)
        let sent = try #require(transport.sent.first)
        #expect(sent.url.absoluteString == "http://mac.tail:7717/embeds/ab12/data.json")
        #expect(sent.headers["authorization"] == "Bearer tok")
        #expect(sent.headers["range"] == "bytes=0-2")
        // Only the embeds route: a page can't make the app call the rest of the API.
        await #expect(throws: URLError.self) { try await client.embedFile("/tickets") }
    }
}
