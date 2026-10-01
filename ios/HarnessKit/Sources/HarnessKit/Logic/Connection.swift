import Foundation

// Port of mobile/src/lib/connection.ts: the reachability + token check before a server is saved,
// and plain-language errors for the failures people actually hit (Mac asleep, service only on
// localhost, stale token).
//
// Error mapping (TS → Swift):
// - TS tells a timeout from other failures by the AbortError its AbortController raises. Here a
//   timeout is `URLError(.timedOut)`, from URLSession's own timeout or from probeServer's
//   deadline; every other thrown error (other URLErrors, an unbuildable URL, anything else) is
//   "unreachable", as any non-abort rejection is in TS.
// - describeError matches /network request failed|failed to fetch|could not connect|load failed/i
//   on the error message, which is how fetch failures read in React Native and browsers. URLSession
//   reports them as URLError codes instead, so the network codes in `unreachableCodes` count as
//   "couldn't reach" too; the message match still runs on `localizedDescription` for anything else.

public enum Connection {
    public struct ProbeFailure: Codable, Equatable, Sendable, Error {
        public enum Kind: String, Codable, Sendable {
            case unreachable
            case timeout
            case unauthorized
            case notHarness = "not-harness"
            case error
        }

        public var kind: Kind
        public var message: String

        public init(kind: Kind, message: String) {
            self.kind = kind
            self.message = message
        }
    }

    /// `{ ok: true, version } | { ok: false, kind, message }`.
    public enum ProbeResult: Codable, Equatable, Sendable {
        case ok(version: String)
        case failure(ProbeFailure)

        private enum CodingKeys: String, CodingKey { case ok, version }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if try c.decode(Bool.self, forKey: .ok) {
                self = .ok(version: try c.decode(String.self, forKey: .version))
            } else {
                self = .failure(try ProbeFailure(from: decoder))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .ok(version):
                try c.encode(true, forKey: .ok)
                try c.encode(version, forKey: .version)
            case let .failure(f):
                try c.encode(false, forKey: .ok)
                try f.encode(to: encoder)
            }
        }
    }

    public static let defaultTimeout: TimeInterval = 6

    public static let unauthorizedMessage = "The service rejected the token (401). Show the pairing QR code on the Mac again and rescan it."

    public static func unreachableMessage(_ baseUrl: String) -> String {
        "Couldn't reach \(MobilePair.displayHost(baseUrl)). Check that the Mac is awake and on the same network or tailnet, and that Harness → Settings → Network lets the service listen beyond localhost."
    }

    /// URLError codes that mean the request never reached a service: the URLSession counterparts
    /// of fetch's "Network request failed" / "Failed to fetch" / "Load failed".
    public static let unreachableCodes: Set<URLError.Code> = [
        .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet,
        .networkConnectionLost, .timedOut, .internationalRoamingOff, .callIsActive, .dataNotAllowed,
        .cannotLoadFromNetwork,
    ]

    /// GET /health (no auth) then an authenticated GET /settings. `timeout` bounds each request
    /// (URLSession's timeout plus a hard deadline, like the TS AbortController).
    public static func probeServer(baseUrl: String, token: String, transport: some HTTPTransport, timeout: TimeInterval = defaultTimeout) async -> ProbeResult {
        let host = MobilePair.displayHost(baseUrl)
        // `replace(/\/$/, "")`: one trailing slash only.
        let base = baseUrl.unicodeScalars.last == "/" ? String(String.UnicodeScalarView(baseUrl.unicodeScalars.dropLast())) : baseUrl
        let version: String
        do {
            let res = try await send(transport, url: "\(base)/health", headers: [:], timeout: timeout)
            // JSON.parse failing leaves `json` as {}; a literal `null` body makes `json.data` throw
            // inside the try, which TS reports as unreachable.
            let json = try? JSONDecoder().decode(JSONValue.self, from: res.body)
            guard res.ok else { return notHarness(host, res.status) }
            if json == .null { return .failure(ProbeFailure(kind: .unreachable, message: unreachableMessage(baseUrl))) }
            let data = json?["data"]
            guard data?["ok"] == .bool(true) else { return notHarness(host, res.status) }
            // `version ?? ""`. A non-string version (which TS would pass through untyped) is "".
            version = data?["version"]?.stringValue ?? ""
        } catch {
            if isTimeout(error) {
                let rest = unreachableMessage(baseUrl).components(separatedBy: ". ").dropFirst().joined(separator: ". ")
                return .failure(ProbeFailure(kind: .timeout, message: "\(host) didn't answer within \(jsRound(timeout))s. \(rest)"))
            }
            return .failure(ProbeFailure(kind: .unreachable, message: unreachableMessage(baseUrl)))
        }
        do {
            let res = try await send(transport, url: "\(base)/settings", headers: ["authorization": "Bearer \(token)"], timeout: timeout)
            if res.status == 401 || res.status == 403 { return .failure(ProbeFailure(kind: .unauthorized, message: unauthorizedMessage)) }
            if !res.ok { return .failure(ProbeFailure(kind: .error, message: "The service answered HTTP \(res.status).")) }
        } catch {
            if isTimeout(error) { return .failure(ProbeFailure(kind: .timeout, message: "\(host) stopped answering.")) }
            return .failure(ProbeFailure(kind: .unreachable, message: unreachableMessage(baseUrl)))
        }
        return .ok(version: version)
    }

    /// A toast-friendly message for a failed request.
    public static func describeError(_ error: any Error, baseUrl: String? = nil) -> String {
        if let e = error as? HarnessAPIError {
            if e.status == 401 { return unauthorizedMessage }
            return e.message.isEmpty ? "HTTP \(e.status)" : e.message
        }
        let message = error.localizedDescription
        let unreachable = (error as? URLError).map { unreachableCodes.contains($0.code) } ?? false
        if unreachable || mentionsNetworkFailure(message) {
            if let baseUrl, !baseUrl.isEmpty { return unreachableMessage(baseUrl) }
            return "Couldn't reach the service."
        }
        return message
    }

    public static func isUnauthorized(_ error: any Error) -> Bool {
        (error as? HarnessAPIError)?.status == 401
    }

    // MARK: Helpers

    private struct InvalidURL: Error {}

    /// One GET with a hard deadline: whichever finishes first, the request or the timer.
    private static func send(_ transport: some HTTPTransport, url: String, headers: [String: String], timeout: TimeInterval) async throws -> HTTPResponse {
        guard let u = URL(string: url) else { throw InvalidURL() }
        let request = HTTPRequest(method: "GET", url: u, headers: headers, timeout: timeout)
        return try await withThrowingTaskGroup(of: HTTPResponse.self) { group in
            group.addTask { try await transport.send(request) }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    private static func isTimeout(_ error: any Error) -> Bool {
        (error as? URLError)?.code == .timedOut
    }

    private static func notHarness(_ host: String, _ status: Int) -> ProbeResult {
        .failure(ProbeFailure(kind: .notHarness, message: "\(host) answered, but it isn't a Harness service (HTTP \(status))."))
    }

    /// `Math.round`: halves round up (toward +∞).
    static func jsRound(_ x: Double) -> Int {
        Int((x + 0.5).rounded(.down))
    }

    /// The TS regex, case-insensitive over ASCII only (JS `/i` without `u` doesn't fold non-ASCII).
    static func mentionsNetworkFailure(_ message: String) -> Bool {
        let lowered = message.unicodeScalars.map { ("A"..."Z").contains($0) ? Unicode.Scalar($0.value + 32)! : $0 }
        return ["network request failed", "failed to fetch", "could not connect", "load failed"].contains { phrase in
            lowered.firstRange(of: Array(phrase.unicodeScalars)) != nil
        }
    }
}
