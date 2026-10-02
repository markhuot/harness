import Foundation

// Pairing links and manual server entry. The desktop app shows a
// QR code of exactly harness://pair?url=<encodeURIComponent(baseUrl)>&token=<…> (Pairing.swift);
// this adds reasons for failures and normalizes the URL the same way manual entry does.
//
// Letter classes are ASCII-only. The regexes below spell out `[a-zA-Z]` (Swift's case-insensitive
// mode folds some non-ASCII letters, such as the Kelvin sign, into `k`) and run with
// `.unicodeScalar` semantics so a combining mark can't glue itself onto a `/`, `:` or `?`.

/// `{ ok: true, value } | { ok: false, error }`.
public enum ParseResult<Value> {
    case ok(Value)
    case failure(String)

    public var value: Value? {
        if case let .ok(v) = self { return v }
        return nil
    }

    public var error: String? {
        if case let .failure(e) = self { return e }
        return nil
    }
}

extension ParseResult: Equatable where Value: Equatable {}
extension ParseResult: Sendable where Value: Sendable {}

extension ParseResult: Codable where Value: Codable {
    private enum CodingKeys: String, CodingKey { case ok, value, error }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(Bool.self, forKey: .ok) {
            self = .ok(try c.decode(Value.self, forKey: .value))
        } else {
            self = .failure(try c.decode(String.self, forKey: .error))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .ok(v):
            try c.encode(true, forKey: .ok)
            try c.encode(v, forKey: .value)
        case let .failure(e):
            try c.encode(false, forKey: .ok)
            try c.encode(e, forKey: .error)
        }
    }
}

public struct ServerAddress: Codable, Equatable, Sendable {
    /// http(s)://host[:port][/path], no trailing slash
    public var baseUrl: String
    public var token: String

    public init(baseUrl: String, token: String) {
        self.baseUrl = baseUrl
        self.token = token
    }
}

public enum MobilePair {
    static let hostError = "That doesn't look like a host name or IP address"
    static let schemeError = "Only http:// and https:// URLs are supported"

    /// Normalize a typed or scanned service URL: trims, adds http:// when no scheme is given (the
    /// service speaks plain http on the LAN / tailnet), lower-cases scheme and host, drops a
    /// trailing slash, query and fragment. Only http and https are accepted.
    public static func normalizeBaseUrl(_ input: String) -> ParseResult<String> {
        var s = input.trimmingJSWhitespace()
        if s.isEmpty { return .failure("Enter the service URL, e.g. http://100.64.0.2:7717") }
        if s.prefixMatch(of: #/[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//#.matchingSemantics(.unicodeScalar)) == nil {
            let looksLikeScheme = s.prefixMatch(of: #/[a-zA-Z][a-zA-Z0-9+.\-]*:/#.matchingSemantics(.unicodeScalar)) != nil
            let looksLikeHostPort = s.prefixMatch(of: #/[^:\/]+:[0-9]/#.matchingSemantics(.unicodeScalar)) != nil
            if looksLikeScheme && !looksLikeHostPort { return .failure(schemeError) }
            s = "http://" + s
        }
        guard let m = s.prefixMatch(of: #/([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^\/?#]*)([^?#]*)/#.matchingSemantics(.unicodeScalar)) else {
            return .failure("That doesn't look like a URL")
        }
        let scheme = m.1.lowercased()
        if scheme != "http" && scheme != "https" { return .failure(schemeError) }
        let authority = m.2
        if authority.unicodeScalars.contains("@") { return .failure("The URL can't contain a user name or password") }
        guard let hm = authority.wholeMatch(of: #/(\[[0-9a-fA-F:.]+\]|[^:\[\]]+)(?::([0-9]*))?/#.matchingSemantics(.unicodeScalar)) else {
            return .failure(hostError)
        }
        let host = hm.1.lowercased()
        if host.unicodeScalars.first != "[",
           host.wholeMatch(of: #/[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*\.?/#.matchingSemantics(.unicodeScalar)) == nil {
            return .failure(hostError)
        }
        var portSuffix = ""
        if let port = hm.2 {
            // Number(port) on ASCII digits; a run too long for Int is out of range either way.
            guard let n = Int(port), (1...65535).contains(n) else { return .failure("The port must be between 1 and 65535") }
            portSuffix = ":\(n)"
        }
        var path = Array(m.3.unicodeScalars)
        while path.last == "/" { path.removeLast() }
        return .ok("\(scheme)://\(host)\(portSuffix)\(String(String.UnicodeScalarView(path)))")
    }

    /// Manual token entry: trimmed, non-empty.
    public static func checkToken(_ token: String) -> ParseResult<String> {
        let t = token.trimmingJSWhitespace()
        return t.isEmpty ? .failure("Enter the token") : .ok(t)
    }

    /// Why a link isn't a usable pairing link (Pairing.parsePairUrl only says nil).
    static func diagnose(_ raw: String) -> String {
        let s = raw.trimmingJSWhitespace()
        guard s.unicodeScalars.starts(with: "\(Pairing.scheme)?".unicodeScalars) else { return "Not a Harness pairing code" }
        if s.firstMatch(of: #/[?&]url=[^&]/#.matchingSemantics(.unicodeScalar)) == nil { return "The pairing code has no service URL" }
        if s.firstMatch(of: #/[?&]token=[^&]/#.matchingSemantics(.unicodeScalar)) == nil { return "The pairing code has no token" }
        if s.firstMatch(of: #/%(?![0-9a-fA-F]{2})/#.matchingSemantics(.unicodeScalar)) != nil {
            return "The pairing code is damaged (bad encoding). Show a fresh QR code on the Mac."
        }
        return "The pairing code's service URL isn't an http(s) address"
    }

    /// harness://pair?url=…&token=… → the server address, with a reason when it isn't one.
    public static func parsePairLink(_ raw: String) -> ParseResult<ServerAddress> {
        guard let parsed = Pairing.parsePairUrl(raw) else { return .failure(diagnose(raw)) }
        switch normalizeBaseUrl(parsed.url) {
        case let .failure(e): return .failure(e)
        case let .ok(base): return .ok(ServerAddress(baseUrl: base, token: parsed.token))
        }
    }

    /// A deep link's already-decoded `url` and `token` values, re-encoded and parsed like a
    /// scanned link. When a param repeats, pass the first value.
    public static func pairParams(url: String?, token: String?) -> ParseResult<ServerAddress> {
        let url = url ?? ""
        let token = token ?? ""
        if url.isEmpty { return .failure("The pairing code has no service URL") }
        if token.isEmpty { return .failure("The pairing code has no token") }
        return parsePairLink(Pairing.buildPairUrl(baseUrl: url, token: token))
    }

    /// "http://100.64.0.2:7717" → "100.64.0.2:7717" for compact display (case-sensitive).
    public static func displayHost(_ baseUrl: String) -> String {
        let u = baseUrl.unicodeScalars
        for p in ["https://", "http://"] where u.starts(with: p.unicodeScalars) {
            return String(String.UnicodeScalarView(u.dropFirst(p.unicodeScalars.count)))
        }
        return baseUrl
    }
}
