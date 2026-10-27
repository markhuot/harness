import Foundation

/// Search qualifiers (`label:` and `project:`), ported from shared/src/labels.ts and tested against
/// the same labels.fixtures.json.
public struct ParsedSearch: Equatable, Sendable {
    public enum Field: String, Sendable { case label, project }

    /// The last word of a query when it is a qualifier still being typed (what a palette completes).
    public struct Completion: Equatable, Sendable {
        public var field: Field
        /// What was typed after the colon, without its opening quote ("" for a bare `label:`)
        public var partial: String
        /// Where the qualifier starts in the query (a Character offset): what a completion replaces from there to the end
        public var start: Int
    }

    /// Every `label:` value, in order: all must match (AND)
    public var labels: [String] = []
    /// Every `project:` value (a project key), in order: a ticket matches any of them (OR)
    public var projects: [String] = []
    /// The query without its qualifiers: what the text search runs on
    public var text: String = ""
    /// How many qualifier words the query held, counting ones with no value yet
    public var qualifiers: Int = 0
    public var completion: Completion?
}

public enum SearchQuery {
    private static let fields: [(prefix: [Character], field: ParsedSearch.Field)] = [
        (Array("label:"), .label), (Array("project:"), .project),
    ]

    /// Split a search into qualifiers and plain text. A qualifier is `label:` or `project:` (any
    /// case) at the start of a word, then a value: bare (up to whitespace) or in double quotes,
    /// which may hold spaces. An unclosed quote runs to the end. Other `foo:bar` words stay text.
    public static func parse(_ query: String) -> ParsedSearch {
        var out = ParsedSearch()
        var text: [String] = []
        let q = Array(query)
        let n = q.count
        var i = 0
        while i < n {
            if q[i].isWhitespace { i += 1; continue }
            let start = i
            if let (prefix, field) = fields.first(where: { hasPrefix(q, at: i, $0.prefix) }) {
                i += prefix.count
                let valueStart = i
                var value: String
                var open = false
                if i < n, q[i] == "\"" {
                    let close = (i + 1..<max(n, i + 1)).first { q[$0] == "\"" }
                    open = close == nil
                    let end = close ?? n
                    value = String(q[(i + 1)..<max(end, i + 1)])
                    i = open ? n : end + 1
                } else {
                    var j = i
                    while j < n, !q[j].isWhitespace { j += 1 }
                    value = String(q[i..<j])
                    i = j
                }
                out.qualifiers += 1
                if i >= n, open || valueStart >= n || q[valueStart] != "\"" {
                    out.completion = .init(field: field, partial: value, start: start)
                }
                let v = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
                if !v.isEmpty {
                    if field == .label { out.labels.append(v) } else { out.projects.append(v) }
                }
                continue
            }
            var j = i
            while j < n, !q[j].isWhitespace { j += 1 }
            text.append(String(q[i..<j]))
            i = j
        }
        out.text = text.joined(separator: " ")
        return out
    }

    private static func hasPrefix(_ q: [Character], at i: Int, _ prefix: [Character]) -> Bool {
        guard i + prefix.count <= q.count else { return false }
        for (k, c) in prefix.enumerated() where q[i + k].lowercased() != String(c) { return false }
        return true
    }

    /// A qualifier value as typed back into a query: bare when it can be, else in quotes.
    public static func quote(_ value: String) -> String {
        !value.isEmpty && !value.contains(where: { $0.isWhitespace || $0 == "\"" }) ? value : "\"\(value)\""
    }

    /// The query with its trailing qualifier-in-progress replaced by a finished `field:value `.
    public static func complete(_ query: String, field: ParsedSearch.Field, value: String) -> String {
        let head: String
        if let c = parse(query).completion {
            head = String(Array(query)[..<c.start])
        } else {
            head = !query.isEmpty && !(query.last?.isWhitespace ?? false) ? query + " " : query
        }
        return "\(head)\(field.rawValue):\(quote(value)) "
    }

    /// The search text a label row sets on the board: `label:<name>`, quoted when needed.
    public static func labelFilter(_ name: String) -> String {
        "label:\(quote(name))"
    }
}
