import Foundation
import Testing
@testable import HarnessKit

/// How a scripted request answers: a status and body, or a thrown error.
enum ScriptedReply: Decodable, Sendable {
    case respond(status: Int, body: String)
    /// network → URLError(.cannotConnectToHost), abort → URLError(.timedOut), other → a non-URL error.
    case fail(String)
    /// Never answers (until cancelled). Swift-only: exercises probeServer's own deadline.
    case hang

    private enum Keys: String, CodingKey { case status, body, `throw` }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let kind = try c.decodeIfPresent(String.self, forKey: .throw) {
            self = .fail(kind)
        } else {
            self = .respond(status: try c.decode(Int.self, forKey: .status), body: try c.decodeIfPresent(String.self, forKey: .body) ?? "")
        }
    }
}

struct SomethingElse: Error {}

/// Answers requests in order from a script and records them, as each fixture case scripts its replies.
actor ScriptedTransport: HTTPTransport {
    private let replies: [ScriptedReply]
    private(set) var requests: [HTTPRequest] = []

    init(_ replies: [ScriptedReply]) {
        self.replies = replies
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        guard requests.count <= replies.count else { throw SomethingElse() }
        switch replies[requests.count - 1] {
        case let .respond(status, body): return HTTPResponse(status: status, body: Data(body.utf8))
        case .fail("network"): throw URLError(.cannotConnectToHost)
        case .fail("abort"): throw URLError(.timedOut)
        case .fail: throw SomethingElse()
        case .hang:
            try await Task.sleep(for: .seconds(60))
            throw SomethingElse()
        }
    }
}

struct ProbeInput: Decodable, Sendable {
    let baseUrl: String
    let token: String
    let timeoutMs: Double?
    let health: ScriptedReply
    let settings: ScriptedReply?
}

struct ProbeCall: Decodable, Sendable, Equatable {
    let url: String
    let authorization: String?
}

struct ProbeOutput: Decodable, Sendable {
    let result: Connection.ProbeResult
    let calls: [ProbeCall]
}

enum ErrorInput: Decodable, Sendable {
    case api(status: Int, message: String)
    case error(message: String)

    private enum Keys: String, CodingKey { case kind, status, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let message = try c.decode(String.self, forKey: .message)
        self = try c.decode(String.self, forKey: .kind) == "api" ? .api(status: try c.decode(Int.self, forKey: .status), message: message) : .error(message: message)
    }

    /// The Swift counterpart of `new HarnessApiError(…)` / `new Error(message)`.
    var swiftError: any Error {
        switch self {
        case let .api(status, message): HarnessAPIError(status: status, message: message)
        case let .error(message): MessageError(message: message)
        }
    }
}

struct MessageError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct DescribeErrorInput: Decodable, Sendable {
    let error: ErrorInput
    let baseUrl: String?
}

@Suite("Connection")
struct ConnectionTests {
    @Test(arguments: Fixture.cases("mobileConnection", "probeServerCases", input: ProbeInput.self, output: ProbeOutput.self))
    func probeServer(_ c: Fixture.Case<ProbeInput, ProbeOutput>) async {
        let transport = ScriptedTransport([c.input.health] + (c.input.settings.map { [$0] } ?? []))
        let timeout = c.input.timeoutMs.map { $0 / 1000 } ?? Connection.defaultTimeout
        let result = await Connection.probeServer(baseUrl: c.input.baseUrl, token: c.input.token, transport: transport, timeout: timeout)
        #expect(result == c.output.result)

        let requests = await transport.requests
        #expect(requests.map { ProbeCall(url: $0.url.absoluteString, authorization: $0.headers["authorization"]) } == c.output.calls)
        for r in requests {
            #expect(r.method == "GET")
            #expect(r.timeout == timeout)
            #expect(r.body == nil)
        }
        // The token goes only to /settings, as the one header there.
        if let health = requests.first { #expect(health.headers.isEmpty) }
        if requests.count > 1 { #expect(requests[1].headers == ["authorization": "Bearer \(c.input.token)"]) }
    }

    @Test(arguments: Fixture.cases("mobileConnection", "describeErrorCases", input: DescribeErrorInput.self, output: String.self))
    func describeError(_ c: Fixture.Case<DescribeErrorInput, String>) {
        #expect(Connection.describeError(c.input.error.swiftError, baseUrl: c.input.baseUrl) == c.output)
    }

    @Test(arguments: Fixture.cases("mobileConnection", "isUnauthorizedCases", input: ErrorInput.self, output: Bool.self))
    func isUnauthorized(_ c: Fixture.Case<ErrorInput, Bool>) {
        #expect(Connection.isUnauthorized(c.input.swiftError) == c.output)
    }

    @Test(arguments: Fixture.cases("mobileConnection", "unreachableMessageCases", input: String.self, output: String.self))
    func unreachableMessage(_ c: Fixture.Case<String, String>) {
        #expect(Connection.unreachableMessage(c.input) == c.output)
    }

    @Test func unauthorizedMessage() throws {
        #expect(Connection.unauthorizedMessage == (try Fixture.value("mobileConnection", "unauthorizedMessage", as: String.self)))
    }

    // MARK: Swift-only seams

    @Test func aHungHealthCheckHitsTheDeadline() async {
        let transport = ScriptedTransport([.hang])
        let started = ContinuousClock.now
        let result = await Connection.probeServer(baseUrl: "http://h:1", token: "t", transport: transport, timeout: 0.05)
        #expect(ContinuousClock.now - started < .seconds(5))
        guard case let .failure(f) = result else { Issue.record("expected a failure, got \(result)"); return }
        #expect(f.kind == .timeout)
        #expect(f.message.hasPrefix("h:1 didn't answer within 0s. Check that the Mac is awake"))
        #expect(await transport.requests.count == 1)
    }

    @Test func aHungSettingsRequestHitsTheDeadline() async {
        let transport = ScriptedTransport([.respond(status: 200, body: #"{"data":{"ok":true}}"#), .hang])
        let result = await Connection.probeServer(baseUrl: "http://h:1", token: "t", transport: transport, timeout: 0.05)
        #expect(result == .failure(.init(kind: .timeout, message: "h:1 stopped answering.")))
    }

    @Test func urlErrorNetworkCodesReadAsUnreachable() {
        for code in [URLError.Code.cannotConnectToHost, .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .timedOut, .dnsLookupFailed] {
            #expect(Connection.describeError(URLError(code), baseUrl: "http://h:1") == Connection.unreachableMessage("http://h:1"))
            #expect(Connection.describeError(URLError(code)) == "Couldn't reach the service.")
        }
        // Not a network failure: the error's own description.
        let bad = URLError(.badServerResponse)
        #expect(Connection.describeError(bad, baseUrl: "http://h:1") == bad.localizedDescription)
        #expect(!Connection.isUnauthorized(URLError(.userAuthenticationRequired)))
    }

    @Test func messageMatchIsASCIICaseInsensitiveOnly() {
        #expect(Connection.mentionsNetworkFailure("TypeError: LOAD FAILED"))
        // U+212A KELVIN SIGN: JS /i without `u` doesn't fold it to k.
        #expect(!Connection.mentionsNetworkFailure("Networ\u{212A} request failed"))
    }

    @Test func jsRoundHalvesGoUp() {
        #expect(Connection.jsRound(2.5) == 3)
        #expect(Connection.jsRound(0.5) == 1)
        #expect(Connection.jsRound(1.499) == 1)
        #expect(Connection.jsRound(0.4) == 0)
    }

    @Test func probeResultRoundTripsThroughJSON() throws {
        for r in [Connection.ProbeResult.ok(version: "1"), .failure(.init(kind: .notHarness, message: "m"))] {
            let data = try JSONEncoder().encode(r)
            #expect(try JSONDecoder().decode(Connection.ProbeResult.self, from: data) == r)
        }
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(Connection.ProbeResult.failure(.init(kind: .notHarness, message: "m")))) as? [String: Any]
        #expect(json?["kind"] as? String == "not-harness")
        #expect(json?["ok"] as? Bool == false)
    }
}
