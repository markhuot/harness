import Foundation

// Port of shared/src/pairing.ts. The pairing link a phone scans:
// harness://pair?url=<encodeURIComponent(baseUrl)>&token=<encodeURIComponent(token)>

public enum Pairing {
    public static let scheme = "harness://pair"

    public struct Link: Codable, Equatable, Sendable {
        public var url: String
        public var token: String
        public init(url: String, token: String) {
            self.url = url
            self.token = token
        }
    }

    /// Build the pairing link. Both values are percent-encoded like encodeURIComponent.
    public static func buildPairUrl(baseUrl: String, token: String) -> String {
        "\(scheme)?url=\(URIComponent.encode(baseUrl))&token=\(URIComponent.encode(token))"
    }

    /// Parse a pairing link; nil when it isn't one or a value is missing / not http(s).
    public static func parsePairUrl(_ link: String) -> Link? {
        let trimmed = link.trimmingJSWhitespace()
        guard trimmed.hasPrefix("\(scheme)?") else { return nil }
        var params: [String: String] = [:]
        for part in trimmed.dropFirst(scheme.count + 1).split(separator: "&", omittingEmptySubsequences: false) {
            guard let eq = part.firstIndex(of: "="), eq > part.startIndex else { continue }
            guard let value = URIComponent.decode(String(part[part.index(after: eq)...])) else { return nil }
            params[String(part[..<eq])] = value
        }
        guard let url = params["url"], !url.isEmpty, let token = params["token"], !token.isEmpty else { return nil }
        guard url.firstMatch(of: /^(?i)https?:\/\/[^\/]+/) != nil else { return nil }
        return Link(url: url, token: token)
    }
}

extension String {
    /// `String.prototype.trim()`: strips whitespace and line terminators from both ends.
    func trimmingJSWhitespace() -> String {
        trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}")))
    }
}
