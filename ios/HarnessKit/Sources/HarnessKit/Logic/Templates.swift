import Foundation

// Port of shared/src/templates.ts. Prompt templates (DESIGN.md "Prompt overrides"): the small
// language the built-in prompts and the user's overrides are written in. The service validates on
// save, and clients show the same error while the user types, so the messages match the TS exactly.
//
//   {{name}}                               the variable's value
//   {{#if name}} … {{else if other}} … {{else}} … {{/if}}
//                                          truthy: a non-empty string, true, a non-zero number
//
// Text outside tags is copied exactly, whitespace and newlines included: no trimming around
// tags. Variable names are letters, digits and underscores, starting with a letter or "_".

/// A template variable's value: `string | boolean | number`.
public enum TemplateValue: Codable, Equatable, Sendable, ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByFloatLiteral, ExpressibleByIntegerLiteral {
    case string(String)
    case bool(Bool)
    case number(Double)

    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }

    public init(from decoder: Decoder) throws {
        switch try JSONValue(from: decoder) {
        case let .string(s): self = .string(s)
        case let .bool(b): self = .bool(b)
        case let .number(n): self = .number(n)
        default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "A template value is a string, boolean or number"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .string(s): try c.encode(s)
        case let .bool(b): try c.encode(b)
        case let .number(n): try c.encode(n)
        }
    }

    /// `String(value)`, as JS prints it into the rendered text.
    public var text: String {
        switch self {
        case let .string(s): s
        case let .bool(b): b ? "true" : "false"
        case let .number(n): JSCompat.string(n)
        }
    }

    /// A non-empty string, true, or a non-zero number (NaN is falsy, as in JS).
    public var isTruthy: Bool {
        switch self {
        case let .string(s): !s.isEmpty
        case let .bool(b): b
        case let .number(n): n != 0 && !n.isNaN
        }
    }
}

/// A parsed template. Encodes as the TS node: `{ type: "text" | "var" | "if", … }`.
public indirect enum TemplateNode: Codable, Equatable, Sendable {
    case text(String)
    case variable(String)
    case ifBlock(name: String, then: [TemplateNode], else: [TemplateNode])

    private enum CodingKeys: String, CodingKey { case type, text, name, then, `else` }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "text": self = .text(try c.decode(String.self, forKey: .text))
        case "var": self = .variable(try c.decode(String.self, forKey: .name))
        case "if":
            self = .ifBlock(
                name: try c.decode(String.self, forKey: .name),
                then: try c.decode([TemplateNode].self, forKey: .then),
                else: try c.decode([TemplateNode].self, forKey: .else)
            )
        case let other: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown template node \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .text(t):
            try c.encode("text", forKey: .type)
            try c.encode(t, forKey: .text)
        case let .variable(n):
            try c.encode("var", forKey: .type)
            try c.encode(n, forKey: .name)
        case let .ifBlock(name, then, els):
            try c.encode("if", forKey: .type)
            try c.encode(name, forKey: .name)
            try c.encode(then, forKey: .then)
            try c.encode(els, forKey: .else)
        }
    }
}

/// A malformed template, or a render that reached a variable it wasn't given.
public struct TemplateError: Error, Equatable, Sendable, LocalizedError {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum Templates {
    private typealias JS = Mentions.JS

    /// Parse a template. Throws TemplateError (with the line) for anything malformed.
    public static func parse(_ src: String) throws(TemplateError) -> [TemplateNode] {
        let s = JS.units(src)
        let root = Block(name: "")
        var stack: [Frame] = []
        func out(_ node: Item) {
            guard let top = stack.last else { return root.then.append(node) }
            if top.inElse { top.block.else.append(node) } else { top.block.then.append(node) }
        }
        var pos = 0
        while pos < s.count {
            guard let open = find(s, openBraces, from: pos) else {
                out(.text(JS.string(s[pos...])))
                break
            }
            if open > pos { out(.text(JS.string(s[pos..<open]))) }
            let line = s[..<open].lazy.filter { $0 == JS.newline }.count + 1
            guard let close = find(s, closeBraces, from: open + 2) else {
                throw TemplateError("Line \(line): \"{{\" is never closed with \"}}\"")
            }
            let raw = JS.string(s[open..<(close + 2)])
            let tag = Array(JSCompat.trim(JS.string(s[(open + 2)..<close])).unicodeScalars)
            pos = close + 2

            let ifName = blockName(tag, ["#if"])
            let elseIfName = blockName(tag, ["else", "if"])
            if let name = ifName ?? elseIfName {
                if !isName(name) { throw TemplateError("Line \(line): \"\(string(name))\" in \(raw) isn't a variable name") }
                let node = Block(name: string(name))
                if elseIfName != nil {
                    guard let top = stack.last else { throw TemplateError("Line \(line): \(raw) without an open {{#if}}") }
                    if top.inElse { throw TemplateError("Line \(line): \(raw) after {{else}}") }
                    top.inElse = true
                    top.block.else.append(.block(node))
                } else {
                    out(.block(node))
                }
                stack.append(Frame(block: node, chained: elseIfName != nil, line: line))
            } else if tag.elementsEqual("else".unicodeScalars) {
                guard let top = stack.last else { throw TemplateError("Line \(line): {{else}} without an open {{#if}}") }
                if top.inElse { throw TemplateError("Line \(line): a second {{else}} in the same {{#if}}") }
                top.inElse = true
            } else if tag.elementsEqual("/if".unicodeScalars) {
                if stack.isEmpty { throw TemplateError("Line \(line): {{/if}} without an open {{#if}}") }
                while stack.removeLast().chained {}
            } else if isName(tag[...]) {
                out(.variable(string(tag)))
            } else {
                throw TemplateError("Line \(line): \(raw) isn't a template tag (use {{name}}, {{#if name}}, {{else}}, {{else if name}} or {{/if}})")
            }
        }
        if let unclosed = stack.first(where: { !$0.chained }) {
            throw TemplateError("Line \(unclosed.line): {{#if \(unclosed.block.name)}} is never closed with {{/if}}")
        }
        return root.then.map(\.node)
    }

    /// Every variable a parsed template reads, in first-use order.
    public static func variables(_ nodes: [TemplateNode]) -> [String] {
        var seen: [String] = []
        func add(_ name: String) { if !seen.contains(where: { JS.same($0, name) }) { seen.append(name) } }
        func walk(_ list: [TemplateNode]) {
            for n in list {
                switch n {
                case .text: break
                case let .variable(name): add(name)
                case let .ifBlock(name, then, els):
                    add(name)
                    walk(then)
                    walk(els)
                }
            }
        }
        walk(nodes)
        return seen
    }

    /// `templateError`: why `src` can't be used as a template that may read only `allowed`, or nil
    /// when it can. Covers malformed tags and blocks and variables the prompt doesn't provide.
    public static func error(_ src: String, allowed: [String]) -> String? {
        let nodes: [TemplateNode]
        do { nodes = try parse(src) } catch { return error.message }
        let unknown = variables(nodes).filter { v in !allowed.contains { JS.same($0, v) } }
        if unknown.isEmpty { return nil }
        let list = unknown.map { "{{\($0)}}" }.joined(separator: ", ")
        let known = allowed.isEmpty ? "it has no variables" : "the variables are \(allowed.map { "{{\($0)}}" }.joined(separator: ", "))"
        return "Unknown variable\(unknown.count > 1 ? "s" : "") \(list): \(known)"
    }

    /// Render a template. A variable the template reads that `vars` lacks is an error, not "".
    public static func render(_ template: String, _ vars: [String: TemplateValue]) throws(TemplateError) -> String {
        try render(parse(template), vars)
    }

    /// Render parsed nodes. A variable the template reads that `vars` lacks is an error, not "".
    public static func render(_ nodes: [TemplateNode], _ vars: [String: TemplateValue]) throws(TemplateError) -> String {
        func value(_ name: String) throws(TemplateError) -> TemplateValue {
            guard let v = vars[name] else { throw TemplateError("Missing template variable {{\(name)}}") }
            return v
        }
        var s = ""
        func walk(_ list: [TemplateNode]) throws(TemplateError) {
            for n in list {
                switch n {
                case let .text(t): s += t
                case let .variable(name): s += try value(name).text
                case let .ifBlock(name, then, els): try walk(value(name).isTruthy ? then : els)
                }
            }
        }
        try walk(nodes)
        return s
    }

    // MARK: Parser internals

    private final class Block {
        let name: String
        var then: [Item] = []
        var `else`: [Item] = []
        init(name: String) { self.name = name }
    }

    private enum Item {
        case text(String)
        case variable(String)
        case block(Block)

        var node: TemplateNode {
            switch self {
            case let .text(t): .text(t)
            case let .variable(n): .variable(n)
            case let .block(b): .ifBlock(name: b.name, then: b.then.map(\.node), else: b.else.map(\.node))
            }
        }
    }

    private final class Frame {
        let block: Block
        var inElse = false
        /// Opened by `{{else if}}`: closed by the same `{{/if}}` as the frame below it
        let chained: Bool
        let line: Int
        init(block: Block, chained: Bool, line: Int) {
            self.block = block
            self.chained = chained
            self.line = line
        }
    }

    private static let openBraces = Array("{{".utf16)
    private static let closeBraces = Array("}}".utf16)

    private static func find(_ s: [UInt16], _ needle: [UInt16], from: Int) -> Int? {
        guard from + needle.count <= s.count else { return nil }
        for i in from...(s.count - needle.count) where s[i] == needle[0] && s[i + 1] == needle[1] { return i }
        return nil
    }

    /// `/^#if\s+(\S+)$/` (words ["#if"]) and `/^else\s+if\s+(\S+)$/` (["else", "if"]): each word
    /// followed by whitespace, then the name, which runs to the end without whitespace.
    private static func blockName(_ tag: [Unicode.Scalar], _ words: [String]) -> ArraySlice<Unicode.Scalar>? {
        var i = 0
        for word in words {
            let w = Array(word.unicodeScalars)
            guard tag.count - i >= w.count, tag[i..<(i + w.count)].elementsEqual(w) else { return nil }
            i += w.count
            let from = i
            while i < tag.count && JSCompat.isWhitespace(tag[i]) { i += 1 }
            guard i > from else { return nil }
        }
        let name = tag[i...]
        guard !name.isEmpty, !name.contains(where: JSCompat.isWhitespace) else { return nil }
        return name
    }

    /// `/^[A-Za-z_][A-Za-z0-9_]*$/`
    private static func isName(_ s: ArraySlice<Unicode.Scalar>) -> Bool {
        guard let first = s.first, isLetter(first) || first == "_" else { return false }
        return s.dropFirst().allSatisfy { isLetter($0) || ("0"..."9").contains($0) || $0 == "_" }
    }

    private static func isLetter(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("A"..."Z").contains(c) }

    private static func string(_ s: some Sequence<Unicode.Scalar>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s)
        return String(v)
    }
}
