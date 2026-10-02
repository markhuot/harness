import Foundation

/// A query-string value: nil and "" are dropped, like `query()` in shared/src/client.ts.
public enum QueryValue: Sendable, Equatable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral {
    case string(String)
    case number(Double)

    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }

    public static func int(_ n: Int?) -> QueryValue? { n.map { .number(Double($0)) } }
    public static func str(_ s: String?) -> QueryValue? { s.map { .string($0) } }

    /// String(v) in JavaScript: integral numbers without a decimal point.
    var text: String {
        switch self {
        case let .string(s): s
        case let .number(n): n.rounded() == n && abs(n) < 1e21 ? String(Int64(n)) : String(n)
        }
    }
}

public enum Query {
    /// application/x-www-form-urlencoded as URLSearchParams writes it: alphanumerics and `*-._`
    /// pass through, space becomes `+`, everything else is percent-encoded UTF-8.
    static let formAllowed: CharacterSet = {
        var set = CharacterSet()
        set.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._ ")
        return set
    }()

    static func formEncode(_ s: String) -> String {
        (s.addingPercentEncoding(withAllowedCharacters: formAllowed) ?? s).replacingOccurrences(of: " ", with: "+")
    }

    /// `?a=1&b=2` from the non-nil, non-empty values in order, or "" when there are none. A key
    /// given twice keeps its first position and last value (URLSearchParams.set).
    public static func build(_ params: [(String, QueryValue?)]) -> String {
        var keys: [String] = []
        var values: [String: String] = [:]
        for (k, v) in params {
            guard let v, !v.text.isEmpty else { continue }
            if values[k] == nil { keys.append(k) }
            values[k] = v.text
        }
        if keys.isEmpty { return "" }
        return "?" + keys.map { "\(formEncode($0))=\(formEncode(values[$0]!))" }.joined(separator: "&")
    }
}
