import Foundation
import Testing
import HarnessKit

/// Answers GET …/file with `view` and GET …/file/raw with `raw`, recording each request.
private final class FilesTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _sent: [HTTPRequest] = []
    let view: FileView
    let raw: HTTPResponse

    init(view: FileView, raw: HTTPResponse) {
        self.view = view
        self.raw = raw
    }

    var sent: [HTTPRequest] { lock.withLock { _sent } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { _sent.append(request) }
        if request.url.path.hasSuffix("/file/raw") { return raw }
        if request.url.path.hasSuffix("/file") {
            let data = try JSONEncoder().encode(view)
            let body = try JSONSerialization.data(withJSONObject: ["data": try JSONSerialization.jsonObject(with: data)])
            return HTTPResponse(status: 200, body: body)
        }
        return HTTPResponse(status: 404, body: Data(#"{"error":"no route"}"#.utf8))
    }
}

private let git = FileGitState(repo: true, tracked: true, dirty: false, untracked: false, ignored: false)
private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])

@MainActor
@Suite struct FileImageTests {
    private func loader(_ view: FileView, raw: HTTPResponse = HTTPResponse(status: 200, body: png), root: FileRoot = .ticket(key: "HARNESS-5")) async -> (FileViewerLoader, FilesTransport) {
        let transport = FilesTransport(view: view, raw: raw)
        let client = HarnessClient(baseUrl: "http://svc.test", token: "tok", transport: transport)
        let loader = FileViewerLoader(client: client, root: root, path: view.path)
        await loader.load()
        return (loader, transport)
    }

    @Test func anImageFileLoadsItsBytesWithTheBearerToken() async throws {
        let (loader, transport) = await loader(FileView(path: "shots/after.png", root: "/r", size: png.count, binary: true, image: "image/png", git: git))
        #expect(loader.image == .ok(png))
        let raw = try #require(transport.sent.first { $0.url.path.hasSuffix("/file/raw") })
        #expect(raw.url.path == "/tickets/HARNESS-5/file/raw")
        #expect(URLComponents(url: raw.url, resolvingAgainstBaseURL: false)?.queryItems == [URLQueryItem(name: "path", value: "shots/after.png")])
        #expect(raw.headers["authorization"] == "Bearer tok")
    }

    @Test func aProjectImageAsksTheProjectsRoute() async throws {
        let (_, transport) = await loader(FileView(path: "a.webp", root: "/r", size: 4, binary: true, image: "image/webp", git: git), root: .project(id: "p1"))
        #expect(transport.sent.contains { $0.url.path == "/projects/p1/file/raw" })
    }

    @Test func aTextFileOrAnImageTooLargeToDrawFetchesNoBytes() async {
        let (text, t1) = await loader(FileView(path: "README.md", root: "/r", size: 3, contents: "hi\n", git: git))
        #expect(text.image == nil)
        #expect(!t1.sent.contains { $0.url.path.hasSuffix("/file/raw") })
        let (big, t2) = await loader(FileView(path: "huge.jpg", root: "/r", size: 60_000_000, binary: true, tooLarge: true, image: "image/jpeg", git: git))
        #expect(big.image == nil)
        #expect(!t2.sent.contains { $0.url.path.hasSuffix("/file/raw") })
    }

    @Test func aFailedImageFetchIsTheServicesError() async {
        let (loader, _) = await loader(
            FileView(path: "gone.png", root: "/r", size: 4, binary: true, image: "image/png", git: git),
            raw: HTTPResponse(status: 404, body: Data(#"{"error":"No such file: gone.png"}"#.utf8)))
        #expect(loader.image == .error(FileLoadError(status: 404, message: "No such file: gone.png")))
        #expect(loader.file.value != nil)
    }

    @Test func anImageIsDrawnNotCalledBinaryUnlessItsTooLarge() {
        #expect(FileViewerRules.fileBody(FileView(path: "a.png", root: "/r", size: 10, binary: true, image: "image/png", git: git)) == .image)
        guard case let .tooLarge(message) = FileViewerRules.fileBody(FileView(path: "a.png", root: "/r", size: 60_000_000, binary: true, tooLarge: true, image: "image/png", git: git)) else {
            Issue.record("expected tooLarge")
            return
        }
        #expect(message.contains("50 MB"))
        #expect(FileViewerRules.fileBody(FileView(path: "a.woff2", root: "/r", size: 10, binary: true, git: git)) == .binary("10 B of binary data."))
        #expect(!FileViewerRules.showsEditor(FileView(path: "a.png", root: "/r", size: 10, binary: true, image: "image/png", git: git)))
    }
}
