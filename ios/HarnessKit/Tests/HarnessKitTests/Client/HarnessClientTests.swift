import Foundation
import Testing
@testable import HarnessKit
import struct HarnessKit.Attachment

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
        _ = try await client(t).ticketPage(status: .done, group: "Side projects", limit: 50)
        #expect(path(t) == "/tickets/page?status=done&group=Side+projects&limit=50")
        _ = try await client(t).searchTickets(q: "x", group: "Work")
        #expect(path(t) == "/tickets/search?q=x&group=Work")
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
        _ = try await client(t, token: "secret").createTicket(CreateTicketBody(projectId: "prj_1", spec: "Do it", start: false))
        let r = try #require(t.last)
        #expect(r.method == "POST")
        #expect(path(t) == "/tickets")
        #expect(r.headers == ["authorization": "Bearer secret", "content-type": "application/json"])
        #expect(try bodyJSON(r) == json(#"{"projectId":"prj_1","spec":"Do it","start":false}"#))
    }

    /// Only the text: no `log` (messages don't go into Activity) and no `move` (a message never moves the ticket).
    @Test func sendMessageSendsOnlyTheText() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        _ = try await client(t).sendMessage("NY-1", text: "hi")
        #expect(try bodyJSON(t.last) == json(#"{"text":"hi"}"#))
        #expect(path(t) == "/tickets/NY-1/messages")
    }

    /// `attachments` only when there are some; the text may be empty then.
    @Test func sendMessageSendsAttachmentsOnlyWhenThereAreSome() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        _ = try await client(t).sendMessage("NY-1", text: "hi", attachments: [])
        #expect(try bodyJSON(t.last) == json(#"{"text":"hi"}"#))
        _ = try await client(t).sendMessage("NY-1", text: "", attachments: [AttachmentInput(id: "a1", name: "a.png"), AttachmentInput(path: "/u/b.pdf")])
        #expect(try bodyJSON(t.last) == json(#"{"text":"","attachments":[{"id":"a1","name":"a.png"},{"path":"/u/b.pdf"}]}"#))
    }

    /// An image's notes ride on its attachment input; one without notes has no `annotation` key.
    @Test func sendMessageSendsEachAttachmentsNotesWithIt() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        let note = AttachmentAnnotation(
            width: 800, height: 600,
            marks: [AnnotationMark(n: 1, x: 10, y: 20, tailX: 100, tailY: 120, message: "this"), AnnotationMark(n: 2, x: 5, y: 6, message: "that")]
        )
        let spec = Attachment(id: "att_1", path: "/h/att_1.png", name: "shot.png", source: .spec, kind: .image, mimeType: "image/png", annotation: note)
        _ = try await client(t).sendMessage("NY-1", text: "Fix these", attachments: PromptAttachments.inputs([spec]) + [AttachmentInput(id: "a2")])
        #expect(try bodyJSON(t.last) == json(#"""
        {"text":"Fix these","attachments":[{"id":"att_1","path":"/h/att_1.png","name":"shot.png","source":"spec","kind":"image","mimeType":"image/png",
         "annotation":{"width":800,"height":600,
         "marks":[{"n":1,"x":10,"y":20,"tailX":100,"tailY":120,"message":"this"},{"n":2,"x":5,"y":6,"message":"that"}]}},{"id":"a2"}]}
        """#))
    }

    @Test func specRoutes() async throws {
        let t = FakeTransport(status: 200, body: try envelope(.array([])))
        _ = try await client(t).specRevisions("NY-1")
        #expect(path(t) == "/tickets/NY-1/spec/revisions")
        _ = try await client(t).listActivity("NY-1")
        #expect(path(t) == "/tickets/NY-1/activity")
        let one = FakeTransport(status: 200, body: try envelope(protocolSample("SpecRevision")))
        _ = try await client(one).specRevision("NY-1", rev: 2)
        #expect(path(one) == "/tickets/NY-1/spec/revisions/2")
    }

    @Test func specPatchSendsBaseRevision() async throws {
        let t = FakeTransport(status: 200, body: try envelope(protocolSample("Ticket")))
        _ = try await client(t).updateTicket("NY-1", UpdateTicketBody(spec: "## Goal", baseRevision: 3))
        #expect(try bodyJSON(t.last) == json(###"{"spec":"## Goal","baseRevision":3}"###))
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

    @Test func browserExtensionCalls() async throws {
        let list = FakeTransport(status: 200, body: try envelope(protocolSample("BrowserExtensionList")))
        let got = try await client(list).listBrowserExtensions()
        #expect(path(list) == "/browser-extensions" && list.last?.method == "GET")
        #expect(got.running && got.extensions.first?.status == .loaded && got.extensions.last?.byPolicy == true)

        let ext = try envelope(protocolSample("BrowserExtension"))
        let add = FakeTransport(status: 200, body: ext)
        _ = try await client(add).addBrowserExtension(.webstore("fmkadmapgofadopljbjfkapdkoienihi"))
        #expect(path(add) == "/browser-extensions" && add.last?.method == "POST")
        #expect(try bodyJSON(add.last) == json(#"{"webstore":"fmkadmapgofadopljbjfkapdkoienihi"}"#))
        let addPath = FakeTransport(status: 200, body: ext)
        _ = try await client(addPath).addBrowserExtension(.path("~/ext"))
        #expect(try bodyJSON(addPath.last) == json(#"{"path":"~/ext"}"#))

        let toggle = FakeTransport(status: 200, body: ext)
        _ = try await client(toggle).setBrowserExtensionEnabled("abc", enabled: false)
        #expect(path(toggle) == "/browser-extensions/abc" && toggle.last?.method == "PATCH")
        #expect(try bodyJSON(toggle.last) == json(#"{"enabled":false}"#))

        let remove = FakeTransport(status: 200, body: #"{"data":{"ok":true}}"#)
        _ = try await client(remove).removeBrowserExtension("abc")
        #expect(path(remove) == "/browser-extensions/abc" && remove.last?.method == "DELETE")

        let restart = FakeTransport(status: 200, body: #"{"data":{"ok":true}}"#)
        _ = try await client(restart).restartBrowser()
        #expect(path(restart) == "/browser/restart" && restart.last?.method == "POST")

        let action = FakeTransport(status: 200, body: #"{"data":{"tab":null}}"#)
        let res = try await client(action).browserExtensionAction("ses_1", id: "abc")
        #expect(res.tab == nil)
        #expect(path(action) == "/browser/ses_1/extension-action")
        #expect(try bodyJSON(action.last) == json(#"{"id":"abc"}"#))
        let actionTab = FakeTransport(status: 200, body: #"{"data":{"tab":4}}"#)
        #expect(try await client(actionTab).browserExtensionAction("ses_1", id: "abc", tabId: 2).tab == 4)
        #expect(try bodyJSON(actionTab.last) == json(#"{"id":"abc","tabId":2}"#))
    }

    @Test func browserCallsCarryTheTabOnlyWhenGiven() async throws {
        let get = FakeTransport(status: 200, body: try envelope(protocolSample("BrowserState")))
        _ = try await client(get).browserState("ses_1", tabId: 3)
        #expect(path(get) == "/browser/ses_1?tab=3")

        let nav = FakeTransport(status: 200, body: try envelope(protocolSample("BrowserState")))
        _ = try await client(nav).browserNavigate("ses_1", url: "http://localhost:3000/", tabId: 2)
        #expect(try bodyJSON(nav.last) == json(#"{"url":"http://localhost:3000/","tabId":2}"#))
    }

    @Test func browserScreenshotAsksForTheTabOnlyWhenGiven() async throws {
        let body = #"{"data":{"data":"iVBORw0KGgo=","width":2560,"height":1600,"viewport":{"width":1280,"height":800},"scale":2,"tabId":3,"url":"http://localhost:3000/","title":"Home"}}"#
        let t = FakeTransport(status: 200, body: body)
        let shot = try await client(t).browserScreenshot("ses_1", tabId: 3)
        #expect(path(t) == "/browser/ses_1/screenshot?tab=3")
        #expect(t.last?.method == "GET")
        #expect(shot.width == 2560 && shot.viewport == AnnotationViewport(width: 1280, height: 800) && shot.scale == 2)
        #expect(shot.png?.starts(with: [0x89, 0x50, 0x4E, 0x47]) == true)
        #expect(shot.page == AnnotationPage(url: "http://localhost:3000/", title: "Home", tabId: 3, viewport: AnnotationViewport(width: 1280, height: 800), scale: 2))
        _ = try await client(t).browserScreenshot("ses_1")
        #expect(path(t) == "/browser/ses_1/screenshot")
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

    @Test func specConflictReadsA409sData() async throws {
        let conflict = try protocolSample("SpecConflict")
        let body = JSONValue.object(["error": .string("The spec changed"), "data": conflict])
        let t = FakeTransport(status: 409, body: String(decoding: try JSONEncoder().encode(body), as: UTF8.self))
        let err = try await #require(throws: HarnessAPIError.self) {
            try await client(t).updateTicket("NY-1", UpdateTicketBody(spec: "Mine", baseRevision: 4))
        }
        #expect(err.specConflict == SpecConflict(currentRevision: 5, spec: "## Goal\n\nChanged by the agent."))
        #expect(HarnessAPIError.specConflict(err) == err.specConflict)
        // The same data on another status, or a 409 without it, isn't a spec conflict.
        #expect(HarnessAPIError(status: 400, message: "x", data: conflict).specConflict == nil)
        #expect(HarnessAPIError(status: 409, message: "x", data: .object(["x": .number(1)])).specConflict == nil)
        #expect(HarnessAPIError.specConflict(CancellationError()) == nil)
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

@Suite("HarnessClient attachments")
struct HarnessClientAttachmentTests {
    static let uploaded = #"{"data":{"id":"att_7","path":"/Users/me/.harness/uploads/u1/My shot.png","name":"My shot.png","source":"upload","kind":"image","mimeType":"image/png","size":6,"width":1,"height":1}}"#

    @Test func uploadSendsRawBytesWithTypeNameAndTokenAndReturnsTheRegisteredAttachment() async throws {
        let t = FakeTransport(status: 200, body: Self.uploaded)
        let bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF])
        let a = try await client(t, token: "tok").uploadAttachment(data: bytes, name: "My shot&1.png", mimeType: "image/png")
        #expect(a == Attachment(
            id: "att_7", path: "/Users/me/.harness/uploads/u1/My shot.png", name: "My shot.png", source: .upload, kind: .image,
            mimeType: "image/png", size: 6, width: 1, height: 1
        ))
        let r = try #require(t.last)
        #expect(r.method == "POST")
        #expect(path(t) == "/uploads?name=My%20shot%261.png")
        #expect(r.body == bytes)
        #expect(r.headers["content-type"] == "image/png")
        #expect(r.headers["authorization"] == "Bearer tok")
    }

    @Test func uploadWithoutATypeIsOctetStream() async throws {
        let t = FakeTransport(status: 200, body: Self.uploaded)
        _ = try await client(t).uploadAttachment(data: Data([1]), name: "a.bin", mimeType: "")
        #expect(t.last?.headers["content-type"] == "application/octet-stream")
    }

    @Test func uploadTooLargeThrowsTheServicesError() async throws {
        let t = FakeTransport(status: 413, body: #"{"error":"Uploads are limited to 100 MB"}"#)
        let err = try await #require(throws: HarnessAPIError.self) {
            try await client(t).uploadAttachment(data: Data([1]), name: "big.mov", mimeType: "video/quicktime")
        }
        #expect(err.status == 413)
        #expect(err.message == "Uploads are limited to 100 MB")
    }

    /// POST /attachments with the path, and the name only when there is one.
    @Test func registerPostsThePathAndOptionalName() async throws {
        let t = FakeTransport(status: 200, body: Self.uploaded)
        let a = try await client(t).registerAttachment(path: "/Users/me/shot.png")
        #expect(a.id == "att_7")
        #expect(t.last?.method == "POST")
        #expect(path(t) == "/attachments")
        #expect(try bodyJSON(t.last) == json(#"{"path":"/Users/me/shot.png"}"#))
        _ = try await client(t).registerAttachment(path: "/Users/me/shot.png", name: "Shot")
        #expect(try bodyJSON(t.last) == json(#"{"path":"/Users/me/shot.png","name":"Shot"}"#))
    }

    /// POST /browser/:sessionId/element with the screenshot's url, scroll and viewport; null (the page moved on) is nil.
    @Test func browserElementAtPostsTheQueryAndReadsNull() async throws {
        let q = BrowserElementQuery(tabId: 2, x: 120.5, y: 40, url: "http://localhost:3000/", scroll: BrowserScroll(x: 0, y: 300), viewport: AnnotationViewport(width: 402, height: 512))
        let t = FakeTransport(status: 200, body: ##"{"data":{"path":"#save","text":"Save"}}"##)
        #expect(try await client(t).browserElementAt("ses_1", q) == BrowserElement(path: "#save", text: "Save"))
        #expect(t.last?.method == "POST")
        #expect(path(t) == "/browser/ses_1/element")
        #expect(try bodyJSON(t.last) == json(#"{"tabId":2,"x":120.5,"y":40,"url":"http://localhost:3000/","scroll":{"x":0,"y":300},"viewport":{"width":402,"height":512}}"#))
        #expect(try await client(FakeTransport(status: 200, body: #"{"data":null}"#)).browserElementAt("ses_1", q) == nil)
    }

    @Test func existsIsAHeadOfTheAttachmentsUrl() async throws {
        let t = FakeTransport(status: 200, body: "")
        #expect(await client(t).attachmentExists("att 1") == true)
        #expect(t.last?.method == "HEAD")
        #expect(path(t) == "/attachments/att%201?token=tok")
    }

    @Test func existsIsFalseOnlyOn404() async throws {
        #expect(await client(FakeTransport(status: 404, body: #"{"error":"gone"}"#)).attachmentExists("a") == false)
        #expect(await client(FakeTransport(status: 500, body: "")).attachmentExists("a") == nil)
        #expect(await HarnessClient(baseUrl: base, token: "tok", transport: FailingTransport()).attachmentExists("a") == nil)
    }

    struct FailingTransport: HTTPTransport {
        func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
    }
}
