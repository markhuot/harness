import Foundation

/// One HTTP exchange, abstracted so the client and the connection probe can be tested with a
/// fake transport (no sockets). URLSessionTransport is the real one.
public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    /// Seconds before the request fails with `URLError(.timedOut)`; nil uses the session default.
    public var timeout: TimeInterval?

    public init(method: String = "GET", url: URL, headers: [String: String] = [:], body: Data? = nil, timeout: TimeInterval? = nil) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.timeout = timeout
    }
}

public struct HTTPResponse: Sendable, Equatable {
    public var status: Int
    public var body: Data

    public init(status: Int, body: Data = Data()) {
        self.status = status
        self.body = body
    }

    public var ok: Bool { (200..<300).contains(status) }
}

public protocol HTTPTransport: Sendable {
    /// Throws URLError for transport failures (`.timedOut` when `request.timeout` elapses).
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

public struct URLSessionTransport: HTTPTransport {
    public let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var r = URLRequest(url: request.url)
        r.httpMethod = request.method
        r.httpBody = request.body
        for (k, v) in request.headers { r.setValue(v, forHTTPHeaderField: k) }
        if let t = request.timeout { r.timeoutInterval = t }
        let (data, response) = try await session.data(for: r)
        return HTTPResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
    }
}
