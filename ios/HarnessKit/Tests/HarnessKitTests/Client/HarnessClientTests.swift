import Foundation
import Testing
@testable import HarnessKit

private let base = "http://127.0.0.1:7717"

/// A client over a transport that answers every request with `body` (default `{ "data": [] }`).
private func client(_ transport: FakeTransport = FakeTransport(), baseUrl: String = base, token: String = "tok") -> HarnessClient {
    HarnessClient(baseUrl: baseUrl, token: token, transport: transport)
}

/// The path + query the client asked for (relative to `base`).
private func path(_ t: FakeTransport) -> String {
    String(t.last!.url.absoluteString.dropFirst(base.count))
}

@Suite("HarnessClient URLs and queries")
struct HarnessClientURLTests {
    @Test func statusListIsCommaJoinedAndEncoded() async throws {
        let t = FakeTransport()
        _ = try await client(t).listTickets(projectId: "prj_1", status: [.inProgress, .review])
        #expect(path(t) == "/tickets?projectId=prj_1&status=in_progress%2Creview")
    }

    @Test func emptyStatusListAndNoProjectIsBare() async throws {
        let t = FakeTransport()
        _ = try await client(t).listTickets(status: [])
        #expect(path(t) == "/tickets")
    }

    @Test func fileSearchWithIgnoredKindAndLimit() async throws {
        let t = FakeTransport()
        _ = try await client(t).projectFiles("prj_1", q: "src/a b", FileSearchOptions(limit: 20, ignored: true, kind: .file))
        #expect(path(t) == "/projects/prj_1/files?q=src%2Fa+b&limit=20&ignored=1&kind=file")
    }

    @Test func ignoredFalseIsLeftOut() async throws {
        let t = FakeTransport()
        _ = try await client(t).ticketFiles("NY-1", q: "x", FileSearchOptions(ignored: false))
        #expect(path(t) == "/tickets/NY-1/files?q=x")
    }

    @Test func bareNumberIsTheLimit() async throws {
        let t = FakeTransport()
        _ = try await client(t).projectFiles("prj_1", q: "ab", limit: 5)
        #expect(path(t) == "/projects/prj_1/files?q=ab&limit=5")
        _ = try await client(t).ticketFiles("NY-1", q: "ab", limit: 7)
        #expect(path(t) == "/tickets/NY-1/files?q=ab&limit=7")
    }

    @Test func emptyQueryValuesAreDropped() async throws {
        let t = FakeTransport()
        _ = try await client(t).projectCommands("prj_1", q: "co", driver: "", limit: 3)
        #expect(path(t) == "/projects/prj_1/commands?q=co&limit=3")
        _ = try await client(t).projectBranches("prj_1", q: "")
        #expect(path(t) == "/projects/prj_1/branches")
    }

    @Test func ticketPageKeepsOrderAndDropsNil() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("TicketPage")))
        _ = try await client(t).ticketPage(status: .done, projectId: "prj_1", q: "", limit: 25, cursor: "c:1")
        #expect(path(t) == "/tickets/page?status=done&projectId=prj_1&limit=25&cursor=c%3A1")
        _ = try await client(t).searchTickets(q: "seek stall")
        #expect(path(t) == "/tickets/search?q=seek+stall")
    }

    @Test func transcriptAfterAndEncodedSubagent() async throws {
        let t = FakeTransport()
        _ = try await client(t).transcript("ses_1")
        #expect(path(t) == "/sessions/ses_1/transcript?after=0")
        _ = try await client(t).transcript("ses_1", after: 12, subagentId: "a/b c")
        #expect(path(t) == "/sessions/ses_1/transcript?after=12&subagent=a%2Fb%20c")
        _ = try await client(t).transcript("ses_1", after: 3, subagentId: "")
        #expect(path(t) == "/sessions/ses_1/transcript?after=3")
    }

    @Test func taskOutputTailOrOffsetAndEncodedId() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("TaskOutput")))
        let out = try await client(t).taskOutput("ses_1", subagentId: "toolu_1")
        #expect(path(t) == "/sessions/ses_1/subagents/toolu_1/output")
        #expect(out.end == 12 && out.available)
        _ = try await client(t).taskOutput("ses_1", subagentId: "a/b c", offset: 0)
        #expect(path(t) == "/sessions/ses_1/subagents/a%2Fb%20c/output?offset=0")
        _ = try await client(t).taskOutput("ses_1", subagentId: "toolu_1", offset: 4096)
        #expect(path(t) == "/sessions/ses_1/subagents/toolu_1/output?offset=4096")
    }

    @Test func listModelsRefreshAndEncodedDriver() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("DriverModels")))
        _ = try await client(t).listModels("my driver", refresh: true)
        #expect(path(t) == "/drivers/my%20driver/models?refresh=1")
        _ = try await client(t).listModels("claude-code")
        #expect(path(t) == "/drivers/claude-code/models")
    }

    @Test func listSessionsKind() async throws {
        let t = FakeTransport()
        _ = try await client(t).listSessions(kind: .triage)
        #expect(path(t) == "/sessions?kind=triage")
        _ = try await client(t).listSessions()
        #expect(path(t) == "/sessions")
    }

    @Test func attachmentUrlEncodesIdAndToken() {
        let c = client(token: "t&k=1 /")
        #expect(c.attachmentUrl("att 1/x.png") == "\(base)/attachments/att%201%2Fx.png?token=t%26k%3D1%20%2F")
    }

    @Test func pluginUiUrlEncodesOnTheClientsBase() {
        #expect(client().pluginUiUrl(pluginId: "my plugin", tabId: "a&b") == "\(base)/plugins/my%20plugin/ui/index.html?tab=a%26b")
    }

    @Test func oneTrailingSlashIsDropped() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Health")))
        _ = try await client(t, baseUrl: "http://h.local:7717/").health()
        #expect(t.last?.url.absoluteString == "http://h.local:7717/health")
        // Only one: `.replace(/\/$/, "")`.
        #expect(client(baseUrl: "http://h.local:7717//").baseUrl == "http://h.local:7717/")
    }
}

@Suite("HarnessClient requests")
struct HarnessClientRequestTests {
    @Test func getHasAuthOnlyAndNoBody() async throws {
        let t = FakeTransport()
        _ = try await client(t, token: "secret").listProjects()
        let r = try #require(t.last)
        #expect(r.method == "GET")
        #expect(r.headers == ["authorization": "Bearer secret"])
        #expect(r.body == nil)
    }

    @Test func postWithoutBodyHasNoContentType() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        _ = try await client(t).startTicket("NY-1")
        let r = try #require(t.last)
        #expect(r.method == "POST")
        #expect(path(t) == "/tickets/NY-1/start")
        #expect(r.headers["content-type"] == nil)
        #expect(r.body == nil)
    }

    @Test func postWithBodyHasJSONContentType() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        _ = try await client(t, token: "secret").createTicket(CreateTicketBody(projectId: "prj_1", prompt: "Do it", start: false))
        let r = try #require(t.last)
        #expect(r.method == "POST")
        #expect(path(t) == "/tickets")
        #expect(r.headers == ["authorization": "Bearer secret", "content-type": "application/json"])
        #expect(try bodyJSON(r) == json(#"{"projectId":"prj_1","prompt":"Do it","start":false}"#))
    }

    @Test func sendMessageSendsMoveOnlyWhenTrue() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        _ = try await client(t).sendMessage("NY-1", text: "hi")
        #expect(try bodyJSON(t.last) == json(#"{"text":"hi"}"#))
        _ = try await client(t).sendMessage("NY-1", text: "hi", move: true)
        #expect(try bodyJSON(t.last) == json(#"{"text":"hi","move":true}"#))
        #expect(path(t) == "/tickets/NY-1/messages")
    }

    @Test func completeTicketDefaultsToEmptyObject() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        _ = try await client(t).completeTicket("NY-1")
        #expect(t.last?.body.map { String(decoding: $0, as: UTF8.self) } == "{}")
        #expect(t.last?.headers["content-type"] == "application/json")
    }

    @Test func patchNullVersusAbsent() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        _ = try await client(t).updateTicket("NY-1", UpdateTicketBody(title: "New", model: .null, baseBranch: .absent, branch: .value("feat/x")))
        let r = try #require(t.last)
        #expect(r.method == "PATCH")
        #expect(path(t) == "/tickets/NY-1")
        #expect(try bodyJSON(r) == json(#"{"title":"New","model":null,"branch":"feat/x"}"#))
    }

    @Test func updateSettingsAndProjectArePatches() async throws {
        let settings = FakeTransport(status: 200, body: try envelope(protocolSample("PublicSettings")))
        _ = try await client(settings).updateSettings(SettingsPatch(watcherDriver: .null, prompts: ["run.work": nil]))
        #expect(settings.last?.method == "PATCH")
        #expect(path(settings) == "/settings")
        #expect(try bodyJSON(settings.last) == json(#"{"watcherDriver":null,"prompts":{"run.work":null}}"#))

        let project = FakeTransport(status: 200, body: try envelope(protocolSample("Project")))
        _ = try await client(project).updateProject("prj_1", UpdateProjectBody(color: .value("red"), baseBranch: .null))
        #expect(project.last?.method == "PATCH")
        #expect(path(project) == "/projects/prj_1")
        #expect(try bodyJSON(project.last) == json(#"{"color":"red","baseBranch":null}"#))
    }

    @Test func deletesAndRuns() async throws {
        let t = FakeTransport(status: 200, body: #"{"data":{"ok":true}}"#)
        #expect(try await client(t).deleteTicket("NY-1") == OkResponse(ok: true))
        #expect(t.last?.method == "DELETE")
        #expect(path(t) == "/tickets/NY-1")
        _ = try await client(t).runWatcher("w_1")
        #expect(t.last?.method == "POST")
        #expect(path(t) == "/watchers/w_1/run")
    }

    @Test func createWatcherNameAndCommandWin() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Watcher")))
        _ = try await client(t).createWatcher(name: "jira", command: "watch-jira", WatcherBody(name: "ignored", cwd: .null, mode: .interval))
        #expect(try bodyJSON(t.last) == json(#"{"name":"jira","command":"watch-jira","mode":"interval","cwd":null}"#))
    }

    @Test func injectOutputLeavesOutMissingPromptAndReturnsNilForNull() async throws {
        let t = FakeTransport(status: 200, body: #"{"data":null}"#)
        let s = try await client(t).injectOutput(source: "jira", text: .object(["k": .number(1)]))
        #expect(s == nil)
        #expect(path(t) == "/watchers/inject")
        #expect(try bodyJSON(t.last) == json(#"{"source":"jira","text":{"k":1}}"#))
    }

    @Test func browserNavigateBodyAndNullState() async throws {
        let nav = FakeTransport(status: 200, body: try envelope(protocolSample("BrowserState")))
        let state = try await client(nav).browserNavigate("ses_1", url: "http://localhost:3000/")
        #expect(state.url == "http://localhost:3000/login")
        #expect(try bodyJSON(nav.last) == json(#"{"url":"http://localhost:3000/"}"#))

        let none = FakeTransport(status: 200, body: #"{"data":null}"#)
        #expect(try await client(none).browserState("ses_1") == nil)
        #expect(path(none) == "/browser/ses_1")
    }

    @Test func decodesData() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Health")))
        let h = try await client(t).health()
        #expect(h.pid == 4242)
        #expect(h.version == "0.9.0")
    }
}

@Suite("HarnessClient envelope errors")
struct HarnessClientErrorTests {
    @Test func errorAndDataDecodeAsRemoteKeyMatches() async throws {
        let matches = try protocolSample("RemoteKeyMatches")
        let body = JSONValue.object(["error": .string("No ticket PLAYR-123"), "data": matches])
        let t = FakeTransport(status: 404, body: String(decoding: try JSONEncoder().encode(body), as: UTF8.self))
        let err = try await #require(throws: HarnessAPIError.self) { try await client(t).getTicket("PLAYR-123") }
        #expect(err.status == 404)
        #expect(err.message == "No ticket PLAYR-123")
        let decoded = try #require(err.data).decode(as: RemoteKeyMatches.self)
        #expect(decoded.requested == "PLAYR-123")
        #expect(decoded == (try matches.decode(as: RemoteKeyMatches.self)))
    }

    @Test func missingErrorFallsBackToStatusText() async throws {
        let t = FakeTransport(status: 409, body: #"{"data":{"x":1}}"#)
        let err = try await #require(throws: HarnessAPIError.self) { try await client(t).pairing() }
        #expect(err.status == 409)
        #expect(err.message == HTTPURLResponse.localizedString(forStatusCode: 409))
        #expect(!err.message.isEmpty)
        #expect(err.data == .object(["x": .number(1)]))
    }

    @Test func emptyErrorBodyUsesStatusText() async throws {
        let t = FakeTransport(status: 401, body: "")
        let err = try await #require(throws: HarnessAPIError.self) { try await client(t).listProjects() }
        #expect(err == HarnessAPIError(status: 401, message: HTTPURLResponse.localizedString(forStatusCode: 401)))
    }

    @Test func nonJSONErrorBodyStillThrowsAPIError() async throws {
        let t = FakeTransport(status: 502, body: "<html>Bad Gateway</html>")
        let err = try await #require(throws: HarnessAPIError.self) { try await client(t).listProjects() }
        #expect(err.status == 502)
        #expect(err.message == HTTPURLResponse.localizedString(forStatusCode: 502))
        #expect(err.data == nil)
    }

    @Test func emptySuccessBodyIsEmptyObject() async throws {
        // `{}` → no data: an optional result is nil, a required one fails to decode (not an API error).
        let t = FakeTransport(status: 200, body: "")
        #expect(try await client(t).browserState("ses_1") == nil)
        await #expect(throws: DecodingError.self) { try await client(t).health() }
    }
}
