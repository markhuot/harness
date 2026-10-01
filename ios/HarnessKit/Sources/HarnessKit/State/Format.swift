import Foundation

// Port of shared/src/state/format.ts: labels, previews and small derivations the desktop and iOS
// UIs present the same way. Pure.
//
// JS semantics kept: the TS regexes have no `u` flag, so they match code units and `i` folds ASCII
// only; literal comparisons here go through `scalarsEqual` (Swift `==` uses canonical equivalence,
// so "\u{212A}" == "K"). `.length`/`.slice` count UTF-16. `Math.round` and number printing go
// through JSCompat, `toFixed` through `JSFixed`, and `JSON.stringify` through `JSJSON`.

public enum Format {
    // MARK: Statuses and drivers

    /// STATUS_LABEL
    public static let statusLabel: [TicketStatus: String] = [
        .planning: "Planning",
        .inProgress: "In progress",
        .blocked: "Blocked",
        .review: "Review",
        .done: "Done",
    ]

    /// Board column placeholder when a column has no tickets. (COLUMN_EMPTY_TEXT)
    public static let columnEmptyText: [TicketStatus: String] = [
        .planning: "Sessions you want to plan first",
        .inProgress: "Agents at work show up here",
        .blocked: "Nothing waiting on you",
        .review: "Nothing to review",
        .done: "Finished work",
    ]

    static let driverShort: [(id: String, label: String)] = [("claude-code", "Claude Code"), ("anthropic-api", "API"), ("dummy", "Dummy")]

    /// A driver's short label: the built-in short name, else the driver list's name (`??`, so an
    /// empty name is kept), else the id.
    public static func driverLabel(_ id: String, drivers: [DriverInfo]? = nil) -> String {
        if let short = driverShort.first(where: { scalarsEqual($0.id, id) }) { return short.label }
        return drivers?.first(where: { scalarsEqual($0.id, id) })?.name ?? id
    }

    public enum DriverIcon: String, Codable, Sendable, Equatable {
        case bot, key, sparkle
    }

    /// Icon for a driver badge.
    public static func driverIcon(_ id: String) -> DriverIcon {
        scalarsEqual(id, "dummy") ? .bot : scalarsEqual(id, "anthropic-api") ? .key : .sparkle
    }

    /// "just now" / "42s ago" / "5m ago" / "3h ago" / "2d ago"; a short date (current locale) past
    /// 30 days; "never" for nil or 0. Each unit rounds from the previous one, as in TS.
    public static func relativeTime(_ ts: Double?, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
        guard let ts, ts != 0, !ts.isNaN else { return "never" }
        let s = JSCompat.round((now - ts) / 1000)
        if s < 10 { return "just now" }
        if s < 60 { return "\(JSCompat.string(s))s ago" }
        let m = JSCompat.round(s / 60)
        if m < 60 { return "\(JSCompat.string(m))m ago" }
        let h = JSCompat.round(m / 60)
        if h < 24 { return "\(JSCompat.string(h))h ago" }
        let d = JSCompat.round(h / 24)
        if d < 30 { return "\(JSCompat.string(d))d ago" }
        // TS: new Date(ts).toLocaleDateString(), which is locale-dependent; the numeric short date
        // in the current locale is the native equivalent.
        return Date(timeIntervalSince1970: ts / 1000).formatted(date: .numeric, time: .omitted)
    }

    /// ~/… for paths under a macOS home directory. (`/^\/Users\/[^/]+/` → "~")
    public static func tildify(_ path: String) -> String {
        let scalars = Array(path.unicodeScalars)
        let head = Array("/Users/".unicodeScalars)
        guard scalars.count > head.count, Array(scalars.prefix(head.count)) == head else { return path }
        var end = head.count
        while end < scalars.count, scalars[end] != "/" { end += 1 }
        guard end > head.count else { return path }
        return "~" + String(String.UnicodeScalarView(scalars[end...]))
    }

    // MARK: Composers

    /// Ticket message composer placeholder by status. (COMPOSER_PLACEHOLDER)
    public static let composerPlaceholder: [TicketStatus: String] = [
        .planning: "Refine the plan…",
        .inProgress: "Send a follow-up…",
        .blocked: "Answer the agent…",
        .review: "Ask about the work, or ask for a change…",
        .done: "Ask about the finished work…",
    ]

    /// The composer's switch, where a message can move the ticket before its agent gets it (off by
    /// default, and back off after each send): a review ticket back to in progress, a done one
    /// re-opened. Elsewhere there's none: the agent moves a planning, in-progress or blocked ticket
    /// itself, and a message to a ticket waiting on a tool approval answers the approval.
    public static func moveSwitchLabel(status: TicketStatus, hasPendingApproval: Bool) -> String? {
        if hasPendingApproval { return nil }
        if status == .review { return "Move to in progress" }
        if status == .done { return "Re-open and move to in progress" }
        return nil
    }

    public static func moveSwitchLabel(_ t: Ticket) -> String? {
        moveSwitchLabel(status: t.status, hasPendingApproval: t.pendingApproval != nil)
    }

    /// Hint under the ticket message composer. While the agent is working on an in-progress or
    /// planning ticket, a message goes into its run (steering); otherwise it waits for the run that's
    /// going. Idle, it says what the message does to the ticket (`move`: the switch is on).
    public static func composerHint(busy: Bool, status: TicketStatus, move: Bool = false) -> String {
        if busy { return status == .inProgress || status == .planning ? "Sent to the running agent" : "Queued behind the current run" }
        if move { return "" }
        switch status {
        case .planning: return "The planning agent will revise"
        case .blocked: return "The agent picks the work back up once this answers it"
        case .review: return "Stays in review unless the agent submits it again"
        case .done: return "Stays done: the agent only answers"
        default: return ""
        }
    }

    public static func composerHint(_ t: Ticket, move: Bool = false) -> String {
        composerHint(busy: t.busy, status: t.status, move: move)
    }

    /// New-session prompt placeholder. Start vs plan is picked when it's submitted, so only the kind matters.
    public static func newSessionPlaceholder(_ kind: TicketKind) -> String {
        kind == .conductor
            ? "Describe a larger job. The conductor splits it into tickets and steers them…"
            : "What should the agent do? Start it now, or plan it first…"
    }

    // MARK: Tools, approvals, permissions

    /// mcp__harness__post_summary → post_summary (`/^mcp__[^_]+__/`)
    public static func shortToolName(_ name: String) -> String {
        let s = Array(name.unicodeScalars)
        let head = Array("mcp__".unicodeScalars)
        guard s.count > head.count, Array(s.prefix(head.count)) == head else { return name }
        var i = head.count
        while i < s.count, s[i] != "_" { i += 1 }
        guard i > head.count, i + 1 < s.count, s[i + 1] == "_" else { return name }
        return String(String.UnicodeScalarView(s[(i + 2)...]))
    }

    public struct ShownInput: Codable, Sendable, Equatable {
        public var label: String
        public var value: String
        public var code: Bool
        public init(label: String, value: String, code: Bool) {
            self.label = label
            self.value = value
            self.code = code
        }
    }

    public struct ApprovalInput: Codable, Sendable, Equatable {
        public var primary: ShownInput?
        public var description: String?
        public var rest: [String: JSONValue]?
        public init(primary: ShownInput?, description: String?, rest: [String: JSONValue]?) {
            self.primary = primary
            self.description = description
            self.rest = rest
        }
    }

    /// Pick the part of a tool input a human needs to judge an approval request.
    ///
    /// Deviation: a non-object input is shown as `JSON.stringify(input, null, 2)`, and objects nested
    /// in it print with sorted keys (JSONValue objects are unordered), where TS keeps insertion order.
    public static func describeApprovalInput(_ toolName: String, input: JSONValue?) -> ApprovalInput {
        guard case let .object(object)? = input else {
            let primary: ShownInput? = switch input {
            case nil, .null?: nil
            case let value?: ShownInput(label: "Input", value: JSJSON.stringify(value, indent: 2), code: true)
            }
            return ApprovalInput(primary: primary, description: nil, rest: nil)
        }
        var o = object
        func take(_ k: String) -> String? {
            o.removeValue(forKey: k)?.stringValue
        }
        let description = take("description")
        let tool = shortToolName(toolName)
        let toolLower = asciiLowercased(tool)
        var primary: ShownInput?
        func pick(_ k: String, _ label: String, _ code: Bool) {
            guard primary == nil, let v = o[k]?.stringValue else { return }
            o.removeValue(forKey: k)
            primary = ShownInput(label: label, value: v, code: code)
        }
        func isOne(_ s: String, of names: [String]) -> Bool {
            names.contains { scalarsEqual(s, $0) }
        }
        if isOne(toolLower, of: ["bash"]) { pick("command", "Command", true) }
        if isOne(toolLower, of: ["write", "edit", "multiedit", "read", "notebookedit"]) {
            pick("file_path", "File", true)
            pick("notebook_path", "File", true)
        }
        if isOne(toolLower, of: ["webfetch", "websearch"]) {
            pick("url", "URL", false)
            pick("query", "Query", false)
        }
        // Harness config tools: a watcher's command line is what the human is really approving.
        let command = o["command"]?.stringValue
        let argsArray: [JSONValue]? = if case let .array(a)? = o["args"] { a } else { nil }
        if isOne(tool, of: ["create_watcher", "update_watcher"]), command != nil || argsArray != nil {
            let args = (argsArray ?? []).map(JSJSON.jsString)
            primary = ShownInput(label: "Command", value: ShellCommandLine.commandLine(command ?? "(unchanged command)", args: args), code: true)
            o.removeValue(forKey: "command")
            o.removeValue(forKey: "args")
        }
        if isOne(tool, of: ["delete_watcher", "run_watcher", "update_watcher"]) { pick("watcher", "Watcher", false) }
        if isOne(tool, of: ["create_project", "delete_project", "update_project"]) {
            pick("path", "Directory", true)
            pick("project_key", "Project", false)
        }
        if scalarsEqual(tool, "delete_ticket") { pick("key", "Ticket", false) }
        pick("command", "Command", true)
        pick("url", "URL", false)
        pick("file_path", "File", true)
        pick("path", "Path", true)
        return ApprovalInput(primary: primary, description: description, rest: o.isEmpty ? nil : o)
    }

    /// Toast after answering an approval.
    public static func approvalToast(_ decision: ApprovalDecision, tool: String, ticketKey: String) -> String {
        decision == .deny ? "Denied \(tool)" : decision == .allowTool ? "\(tool) allowed on \(ticketKey)" : "Allowed \(tool) once"
    }

    public static func permissionVerb(decision: PermissionDecision, source: PermissionSource) -> String {
        decision == .allow ? (source == .classifier ? "Auto-approved" : "Allowed") : decision == .ask ? "Asked you" : "Denied"
    }

    public static func permissionVerb(_ log: PermissionDecisionLog) -> String {
        permissionVerb(decision: log.decision, source: log.source)
    }

    /// "classifier · claude-cli · 2.4s" / "policy"
    public static func decisionSource(source: PermissionSource, backend: String?, latencyMs: Double?) -> String {
        var parts = [source.rawValue]
        if let backend, !backend.isEmpty { parts.append(backend) }
        if let latencyMs { parts.append("\(JSFixed.toFixed(latencyMs / 1000, 1))s") }
        return parts.joined(separator: " · ")
    }

    public static func decisionSource(_ log: PermissionDecisionLog) -> String {
        decisionSource(source: log.source, backend: log.backend, latencyMs: log.latencyMs)
    }

    public static func permissionModeLabel(_ mode: PermissionMode) -> String {
        Permissions.label(for: mode)?.label ?? mode.rawValue
    }

    /// CLASSIFIER_LABELS
    public static let classifierLabels: [ClassifierBackend: String] = [
        .claudeCli: "Claude CLI (your Claude plan)",
        .anthropicApi: "Anthropic API (API key)",
        .off: "Off (ask me instead)",
    ]

    // MARK: Transcript

    /// A transcript row: a plain entry, or a tool call with its result (once it arrives).
    public enum TranscriptItem: Sendable, Equatable, Identifiable {
        case entry(TranscriptEntry)
        case tool(call: TranscriptEntry, result: TranscriptEntry?)

        /// The entry's id, or the call's.
        public var id: String {
            switch self {
            case let .entry(e): e.id
            case let .tool(call, _): call.id
            }
        }
    }

    /// Pair each tool_call with its tool_result (by callId) so they render as one collapsible row.
    public static func groupTranscript(_ entries: [TranscriptEntry]) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        var calls: [String: Int] = [:]
        for e in entries {
            switch e.content {
            case let .toolCall(callId, _, _):
                calls[callId] = items.count
                items.append(.tool(call: e, result: nil))
            case let .toolResult(callId, _, _, _) where calls[callId] != nil:
                let i = calls[callId]!
                if case let .tool(call, _) = items[i] { items[i] = .tool(call: call, result: e) }
            default:
                items.append(.entry(e))
            }
        }
        return items
    }

    static let previewKeys = ["command", "url", "path", "file_path", "selector", "pattern", "key", "title", "question", "summary", "expression", "text"]

    /// One-line preview of a tool input, e.g. the bash command or file path.
    ///
    /// Deviation: with no preview field, an object prints as compact JSON with sorted keys (JSONValue
    /// objects are unordered), where TS keeps insertion order.
    public static func toolPreview(_ name: String, input: JSONValue?) -> String {
        switch input {
        case nil, .null?: return ""
        case let .object(o)?:
            for k in previewKeys {
                if let s = o[k]?.stringValue, !s.isEmpty {
                    let line = s.unicodeScalars.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? []
                    return String(String.UnicodeScalarView(line))
                }
            }
            let s = JSJSON.stringify(.object(o), indent: nil)
            return s == "{}" ? "" : s
        case let .array(a)?:
            return JSJSON.stringify(.array(a), indent: nil)
        case let value?:
            return JSJSON.jsString(value)
        }
    }

    public enum ToolIcon: String, Codable, Sendable, Equatable {
        case terminal, globe, tool
    }

    /// Icon for a tool row.
    public static func toolIcon(_ name: String) -> ToolIcon {
        if scalarsEqual(name, "bash") || scalarsEqual(name, "Bash") { return .terminal }
        return name.unicodeScalars.starts(with: "browser".unicodeScalars) ? .globe : .tool
    }

    /// Pretty-print JSON-looking tool output; cap very long text (`max` in UTF-16 code units).
    public static func formatMaybeJson(_ text: String, max: Int = 20000) -> String {
        let t = Array(JSCompat.trim(text).utf16)
        if let first = t.first, let last = t.last,
           (first == 0x7B && last == 0x7D) || (first == 0x5B && last == 0x5D),
           let parsed = JSJSON.parse(t) {
            return JSJSON.stringify(parsed, indent: 2)
        }
        let units = Array(text.utf16)
        guard units.count > max else { return text }
        // A cut through a surrogate pair leaves a lone surrogate in JS; Swift decodes it as U+FFFD.
        return String(decoding: units.prefix(Swift.max(max, 0)), as: UTF16.self) + "\n… (\(units.count - max) more characters)"
    }

    // MARK: Inbox

    public enum Tone: String, Codable, Sendable, Equatable {
        case amber, green, neutral, red
    }

    public struct TriageLabel: Codable, Sendable, Equatable {
        public var label: String
        public var tone: Tone
        public init(label: String, tone: Tone) {
            self.label = label
            self.tone = tone
        }
    }

    /// TRIAGE_LABEL
    public static let triageLabel: [TriageStatus: TriageLabel] = [
        .triaging: TriageLabel(label: "Triaging", tone: .amber),
        .dispatched: TriageLabel(label: "Dispatched", tone: .green),
        .declined: TriageLabel(label: "Declined", tone: .neutral),
        .failed: TriageLabel(label: "Failed", tone: .red),
    ]

    /// "Dispatched to FOO-123" → "FOO-123" (the ticket a triage outcome names).
    public static func dispatchedKey(_ session: Session) -> String? {
        dispatchedKey(outcome: session.outcome)
    }

    /// `/\b[A-Z][A-Z0-9_]*-\d+\b/`, first match. `\b` and `\d` are ASCII (no `u` flag).
    public static func dispatchedKey(outcome: String?) -> String? {
        guard let outcome else { return nil }
        let s = Array(outcome.unicodeScalars)
        func isWord(_ c: Unicode.Scalar) -> Bool {
            switch c {
            case "A"..."Z", "a"..."z", "0"..."9", "_": true
            default: false
            }
        }
        func isDigit(_ c: Unicode.Scalar) -> Bool { ("0"..."9").contains(c) }
        for start in s.indices {
            guard ("A"..."Z").contains(s[start]), start == 0 || !isWord(s[start - 1]) else { continue }
            var i = start + 1
            while i < s.count, ("A"..."Z").contains(s[i]) || isDigit(s[i]) || s[i] == "_" { i += 1 }
            guard i < s.count, s[i] == "-" else { continue }
            i += 1
            let digits = i
            while i < s.count, isDigit(s[i]) { i += 1 }
            guard i > digits, i == s.count || !isWord(s[i]) else { continue }
            return String(String.UnicodeScalarView(s[start..<i]))
        }
        return nil
    }

    // MARK: Browser

    /// URL bar input → a navigable URL ("example.com" → "https://example.com"); "" when empty.
    public static func normalizeUrl(_ raw: String) -> String {
        let t = JSCompat.trim(raw)
        if t.isEmpty { return "" }
        // /^[a-z][a-z0-9+.-]*:/i
        let s = Array(t.unicodeScalars)
        func isAlpha(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("A"..."Z").contains(c) }
        if isAlpha(s[0]) {
            var i = 1
            while i < s.count, isAlpha(s[i]) || ("0"..."9").contains(s[i]) || s[i] == "+" || s[i] == "." || s[i] == "-" { i += 1 }
            if i < s.count, s[i] == ":" { return t }
        }
        return "https://" + t
    }

    public struct Rect: Codable, Sendable, Equatable {
        public var x: Double
        public var y: Double
        public var w: Double
        public var h: Double
        public init(x: Double, y: Double, w: Double, h: Double) {
            self.x = x
            self.y = y
            self.w = w
            self.h = h
        }
    }

    public struct Point: Codable, Sendable, Equatable {
        public var x: Double
        public var y: Double
        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    public struct Size: Codable, Sendable, Equatable {
        public var width: Double
        public var height: Double
        public init(width: Double, height: Double) {
            self.width = width
            self.height = height
        }
    }

    /// Letterbox a w×h image into a box, preserving aspect ratio.
    public static func fitRect(boxW: Double, boxH: Double, w: Double, h: Double) -> Rect {
        if !truthy(w) || !truthy(h) || !truthy(boxW) || !truthy(boxH) { return Rect(x: 0, y: 0, w: 0, h: 0) }
        let a = boxW / w, b = boxH / h
        // Math.min: NaN if either is NaN.
        let scale = a.isNaN || b.isNaN ? Double.nan : Swift.min(a, b)
        let dw = w * scale
        let dh = h * scale
        return Rect(x: (boxW - dw) / 2, y: (boxH - dh) / 2, w: dw, h: dh)
    }

    /// A point in the drawn frame (local to the box the frame is letterboxed into) → page CSS pixels.
    /// nil when the point is outside the drawn image or nothing is drawn yet.
    public static func toPagePoint(_ local: Point, drawn: Rect, page: Size) -> Point? {
        if !truthy(drawn.w) || !truthy(drawn.h) || !truthy(page.width) || !truthy(page.height) { return nil }
        let lx = local.x - drawn.x
        let ly = local.y - drawn.y
        if lx < 0 || ly < 0 || lx > drawn.w || ly > drawn.h { return nil }
        return Point(x: JSCompat.round((lx / drawn.w) * page.width), y: JSCompat.round((ly / drawn.h) * page.height))
    }

    // MARK: Helpers

    /// JS truthiness for a number: 0 and NaN are falsy.
    static func truthy(_ x: Double) -> Bool { x != 0 && !x.isNaN }

    /// Code-unit (scalar) equality, as `===` compares strings.
    static func scalarsEqual(_ a: String, _ b: String) -> Bool {
        a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }

    /// Lower-cases A–Z only: what a non-unicode `/…/i` regex folds for an ASCII pattern.
    static func asciiLowercased(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.map { ("A"..."Z").contains($0) ? Unicode.Scalar($0.value + 32)! : $0 }))
    }
}

// MARK: - Number.prototype.toFixed

enum JSFixed {
    /// `x.toFixed(digits)`: rounds the exact binary value half up (ties to the larger n), unlike
    /// printf's ties-to-even. Falls back to `String(x)` at |x| ≥ 1e21, as JS does.
    static func toFixed(_ x: Double, _ digits: Int) -> String {
        if !x.isFinite || abs(x) >= 1e21 { return JSCompat.string(x) }
        let sign = x < 0 ? "-" : ""
        // 500 places hold the exact expansion of every double that can reach a tie at ≤ 100 places.
        let exact = String(format: "%.500f", abs(x))
        let parts = exact.split(separator: ".", maxSplits: 1)
        let intPart = Array(parts[0])
        let frac = Array(parts.count > 1 ? parts[1] : "")
        var kept = intPart + frac.prefix(digits)
        if frac.count > digits, frac[digits] >= "5" {
            var i = kept.count - 1
            while i >= 0 {
                if kept[i] == "9" { kept[i] = "0"; i -= 1 } else { kept[i] = Character(String(kept[i].wholeNumberValue! + 1)); break }
            }
            if i < 0 { kept.insert("1", at: 0) }
        }
        let n = kept.count - digits
        let head = String(kept[..<n])
        return digits == 0 ? sign + head : sign + head + "." + String(kept[n...])
    }
}

// MARK: - JSON.parse / JSON.stringify

/// JSON with JS object semantics: keys keep insertion order (array-index keys first, ascending, as
/// in JS property order) and strings are UTF-16 code units, so lone surrogates survive a round trip.
enum JSJSON {
    indirect enum Value: Equatable {
        case null
        case bool(Bool)
        case number(Double)
        case string([UInt16])
        case array([Value])
        case object([(key: [UInt16], value: Value)])

        static func == (a: Value, b: Value) -> Bool {
            switch (a, b) {
            case (.null, .null): true
            case let (.bool(x), .bool(y)): x == y
            case let (.number(x), .number(y)): x == y
            case let (.string(x), .string(y)): x == y
            case let (.array(x), .array(y)): x == y
            case let (.object(x), .object(y)): x.count == y.count && zip(x, y).allSatisfy { $0.key == $1.key && $0.value == $1.value }
            default: false
            }
        }
    }

    // MARK: Parse

    /// `JSON.parse` over UTF-16 code units; nil where it would throw.
    static func parse(_ units: [UInt16]) -> Value? {
        var p = Parser(s: units)
        p.skipWhitespace()
        guard let v = p.value() else { return nil }
        p.skipWhitespace()
        return p.i == units.count ? v : nil
    }

    struct Parser {
        let s: [UInt16]
        var i = 0

        func peek() -> UInt16? { i < s.count ? s[i] : nil }

        mutating func skipWhitespace() {
            while let c = peek(), c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D { i += 1 }
        }

        mutating func literal(_ word: String) -> Bool {
            let w = Array(word.utf16)
            guard i + w.count <= s.count, Array(s[i..<(i + w.count)]) == w else { return false }
            i += w.count
            return true
        }

        mutating func value() -> Value? {
            guard let c = peek() else { return nil }
            switch c {
            case 0x7B: return object()
            case 0x5B: return array()
            case 0x22: return string().map(Value.string)
            case 0x74: return literal("true") ? .bool(true) : nil
            case 0x66: return literal("false") ? .bool(false) : nil
            case 0x6E: return literal("null") ? .null : nil
            case 0x2D, 0x30...0x39: return number()
            default: return nil
            }
        }

        mutating func object() -> Value? {
            i += 1
            var members: [(key: [UInt16], value: Value)] = []
            skipWhitespace()
            if peek() == 0x7D { i += 1; return .object(members) }
            while true {
                skipWhitespace()
                guard peek() == 0x22, let key = string() else { return nil }
                skipWhitespace()
                guard peek() == 0x3A else { return nil }
                i += 1
                skipWhitespace()
                guard let v = value() else { return nil }
                // A repeated key keeps its first position and takes the last value.
                if let at = members.firstIndex(where: { $0.key == key }) { members[at].value = v } else { members.append((key, v)) }
                skipWhitespace()
                switch peek() {
                case 0x2C: i += 1
                case 0x7D: i += 1; return .object(members)
                default: return nil
                }
            }
        }

        mutating func array() -> Value? {
            i += 1
            var items: [Value] = []
            skipWhitespace()
            if peek() == 0x5D { i += 1; return .array(items) }
            while true {
                skipWhitespace()
                guard let v = value() else { return nil }
                items.append(v)
                skipWhitespace()
                switch peek() {
                case 0x2C: i += 1
                case 0x5D: i += 1; return .array(items)
                default: return nil
                }
            }
        }

        mutating func string() -> [UInt16]? {
            i += 1
            var out: [UInt16] = []
            while let c = peek() {
                i += 1
                switch c {
                case 0x22: return out
                case 0x5C:
                    guard let e = peek() else { return nil }
                    i += 1
                    switch e {
                    case 0x22, 0x5C, 0x2F: out.append(e)
                    case 0x62: out.append(0x08)
                    case 0x66: out.append(0x0C)
                    case 0x6E: out.append(0x0A)
                    case 0x72: out.append(0x0D)
                    case 0x74: out.append(0x09)
                    case 0x75:
                        guard i + 4 <= s.count else { return nil }
                        var v: UInt16 = 0
                        for h in s[i..<(i + 4)] {
                            guard let d = hexDigit(h) else { return nil }
                            v = v * 16 + d
                        }
                        i += 4
                        out.append(v)
                    default: return nil
                    }
                case 0x00..<0x20: return nil
                default: out.append(c)
                }
            }
            return nil
        }

        func hexDigit(_ c: UInt16) -> UInt16? {
            switch c {
            case 0x30...0x39: c - 0x30
            case 0x41...0x46: c - 0x41 + 10
            case 0x61...0x66: c - 0x61 + 10
            default: nil
            }
        }

        mutating func number() -> Value? {
            let start = i
            func digits() -> Int {
                let from = i
                while let c = peek(), (0x30...0x39).contains(c) { i += 1 }
                return i - from
            }
            if peek() == 0x2D { i += 1 }
            if peek() == 0x30 { i += 1 } else if digits() == 0 { return nil }
            if peek() == 0x2E {
                i += 1
                guard digits() > 0 else { return nil }
            }
            if peek() == 0x65 || peek() == 0x45 {
                i += 1
                if peek() == 0x2B || peek() == 0x2D { i += 1 }
                guard digits() > 0 else { return nil }
            }
            // Correctly rounded, like JS; out of range is ±Infinity.
            guard let d = Double(String(decoding: s[start..<i], as: UTF16.self)) else { return nil }
            return .number(d)
        }
    }

    // MARK: Stringify

    /// `JSON.stringify(value, null, indent)` (`indent: nil` is the compact form). JSONValue objects
    /// are unordered, so their keys are sorted (by code unit, as JS `<` compares).
    static func stringify(_ value: JSONValue, indent: Int?) -> String {
        stringify(ordered(value), indent: indent)
    }

    static func stringify(_ value: Value, indent: Int?) -> String {
        var out: [UInt16] = []
        write(value, indent: indent.map { Array(repeating: UInt16(0x20), count: $0) }, current: [], into: &out)
        return String(decoding: out, as: UTF16.self)
    }

    static func ordered(_ v: JSONValue) -> Value {
        switch v {
        case .null: .null
        case let .bool(b): .bool(b)
        case let .number(n): .number(n)
        case let .string(s): .string(Array(s.utf16))
        case let .array(a): .array(a.map(ordered))
        case let .object(o):
            .object(o.map { (key: Array($0.key.utf16), value: ordered($0.value)) }.sorted { $0.key.lexicographicallyPrecedes($1.key) })
        }
    }

    /// An array index ("0", "7", "4294967294"): JS lists these keys first, in numeric order.
    static func arrayIndex(_ key: [UInt16]) -> UInt64? {
        guard !key.isEmpty, key.count <= 10, key.allSatisfy({ (0x30...0x39).contains($0) }) else { return nil }
        if key.count > 1, key[0] == 0x30 { return nil }
        let n = key.reduce(UInt64(0)) { $0 * 10 + UInt64($1 - 0x30) }
        return n <= 4_294_967_294 ? n : nil
    }

    /// OwnPropertyKeys order: array indices ascending, then the rest in insertion order.
    static func propertyOrder(_ members: [(key: [UInt16], value: Value)]) -> [(key: [UInt16], value: Value)] {
        let indexed = members.compactMap { m in arrayIndex(m.key).map { (n: $0, m: m) } }.sorted { $0.n < $1.n }.map(\.m)
        return indexed + members.filter { arrayIndex($0.key) == nil }
    }

    static func write(_ v: Value, indent: [UInt16]?, current: [UInt16], into out: inout [UInt16]) {
        switch v {
        case .null: out += Array("null".utf16)
        case let .bool(b): out += Array((b ? "true" : "false").utf16)
        case let .number(n): out += Array((n.isFinite ? JSCompat.string(n) : "null").utf16)
        case let .string(s): quote(s, into: &out)
        case let .array(items):
            writeList(items.count, open: 0x5B, close: 0x5D, indent: indent, current: current, into: &out) { i, inner, out in
                write(items[i], indent: indent, current: inner, into: &out)
            }
        case let .object(members):
            let sorted = propertyOrder(members)
            writeList(sorted.count, open: 0x7B, close: 0x7D, indent: indent, current: current, into: &out) { i, inner, out in
                quote(sorted[i].key, into: &out)
                out.append(0x3A)
                if indent != nil { out.append(0x20) }
                write(sorted[i].value, indent: indent, current: inner, into: &out)
            }
        }
    }

    static func writeList(
        _ count: Int, open: UInt16, close: UInt16, indent: [UInt16]?, current: [UInt16], into out: inout [UInt16],
        item: (Int, [UInt16], inout [UInt16]) -> Void
    ) {
        out.append(open)
        guard count > 0 else { out.append(close); return }
        let inner = current + (indent ?? [])
        for i in 0..<count {
            if i > 0 { out.append(0x2C) }
            if indent != nil { out.append(0x0A); out += inner }
            item(i, inner, &out)
        }
        if indent != nil { out.append(0x0A); out += current }
        out.append(close)
    }

    /// QuoteJSONString: the short escapes, other controls and lone surrogates as lower-case \uXXXX.
    static func quote(_ s: [UInt16], into out: inout [UInt16]) {
        func escape(_ c: UInt16) {
            out += Array("\\u".utf16)
            let hex = Array(String(c, radix: 16).utf16)
            out += Array(repeating: 0x30, count: 4 - hex.count) + hex
        }
        out.append(0x22)
        var i = 0
        while i < s.count {
            let c = s[i]
            switch c {
            case 0x22: out += [0x5C, 0x22]
            case 0x5C: out += [0x5C, 0x5C]
            case 0x08: out += [0x5C, 0x62]
            case 0x0C: out += [0x5C, 0x66]
            case 0x0A: out += [0x5C, 0x6E]
            case 0x0D: out += [0x5C, 0x72]
            case 0x09: out += [0x5C, 0x74]
            case 0x00..<0x20: escape(c)
            case 0xD800...0xDBFF:
                if i + 1 < s.count, (0xDC00...0xDFFF).contains(s[i + 1]) {
                    out += [c, s[i + 1]]
                    i += 1
                } else {
                    escape(c)
                }
            case 0xDC00...0xDFFF: escape(c)
            default: out.append(c)
            }
            i += 1
        }
        out.append(0x22)
    }

    /// `String(value)` for a JSON value: arrays join their items with "," (null → ""), objects are
    /// "[object Object]".
    static func jsString(_ v: JSONValue) -> String {
        switch v {
        case .null: "null"
        case let .bool(b): b ? "true" : "false"
        case let .number(n): JSCompat.string(n)
        case let .string(s): s
        case let .array(a): a.map { $0 == .null ? "" : jsString($0) }.joined(separator: ",")
        case .object: "[object Object]"
        }
    }
}
