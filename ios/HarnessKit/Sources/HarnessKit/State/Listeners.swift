import Foundation

/// Port of shared/src/state/listeners.ts: the listeners (watchers) a chief of staff manages, as its
/// Listeners tab shows them, derived from the watchers the store already holds.
public enum Listeners {
    /// The watchers a chief manages, paused last, then by name. The All chief manages every watcher;
    /// a group's chief only its own.
    public static func forChief(_ watchers: [Watcher], chief: Cos) -> [Watcher] {
        let own = chief.scope == "all" ? watchers : watchers.filter { $0.cosId.optional == chief.ticketId }
        return own.sorted {
            if $0.enabled != $1.enabled { return $0.enabled }
            let byName = $0.name.localizedCompare($1.name)
            if byName != .orderedSame { return byName == .orderedAscending }
            return $0.id < $1.id
        }
    }

    private static let secretWord = "(?:token|secret|password|passwd|pass|pwd|key|auth|credential|cookie)"
    private static let mask = "***"
    private static let value = #"("[^"]*"|'[^']*'|[^\s"']+)"#

    private static func replace(_ s: String, _ pattern: String, _ template: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return s }
        return re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: template)
    }

    /// Masks what looks like a credential in one line of text: inline headers, `--token x` flags,
    /// `FOO_KEY=x` assignments and URL passwords. Best effort, not a guarantee.
    public static func maskSecrets(_ line: String) -> String {
        var s = replace(line, #"(authorization\s*[:=]\s*)[^"'\n]+"#, "$1\(mask)")
        s = replace(s, #"\b(bearer|basic)\s+[^\s"']+"#, "$1 \(mask)")
        s = replace(s, #"(--?[\w-]*\#(secretWord)[\w-]*)(=|\s+)\#(value)"#, "$1$2\(mask)")
        s = replace(s, #"(\b\w*\#(secretWord)\w*=)\#(value)"#, "$1\(mask)")
        return replace(s, #"(://[^\s/:@]*:)[^\s/@]+@"#, "$1\(mask)@")
    }

    private static func clip(_ text: String, _ max: Int) -> String {
        guard text.count > max else { return text }
        return String(text.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    private static func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init) ?? ""
    }

    private static func squash(_ s: String) -> String {
        replace(s, #"\s+"#, " ").trimmingCharacters(in: .whitespaces)
    }

    /// What a listener runs, safe to show: the command's first line with leading `VAR=value`
    /// assignments dropped, credentials masked and the whole cut to `max` characters. Never `env`.
    public static func command(_ w: Watcher, max: Int = 90) -> String {
        let first = firstLine(Watchers.watcherCommandLine(w))
        let bare = replace(first, #"^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+"#, "")
        return clip(squash(maskSecrets(bare)), max)
    }

    /// A listener's last error, masked and cut to one short line ("" when it has none).
    public static func error(_ w: Watcher, max: Int = 120) -> String {
        guard let e = w.lastError else { return "" }
        return clip(squash(maskSecrets(firstLine(e))), max)
    }

    public enum Status: String, Sendable {
        case paused, running, error, active

        public var label: String {
            switch self {
            case .paused: "Paused"
            case .running: "Running"
            case .error: "Error"
            case .active: "Active"
            }
        }
    }

    /// paused (switched off), running (a process is alive), error (the last run failed), else
    /// active (waiting for its next run).
    public static func status(_ w: Watcher) -> Status {
        if !w.enabled { return .paused }
        if w.live?.state == .running { return .running }
        if let e = w.lastError, !e.isEmpty { return .error }
        return .active
    }

    /// How often it runs: "Every 5m" for an interval, "Runs continuously" for a loop.
    public static func schedule(_ w: Watcher) -> String {
        if w.mode == .loop { return "Runs continuously" }
        let s = w.intervalSec
        if s % 86400 == 0 { return "Every \(s / 86400)d" }
        if s % 3600 == 0 { return "Every \(s / 3600)h" }
        if s % 60 == 0 { return "Every \(s / 60)m" }
        return "Every \(s)s"
    }

    /// When it runs next, if the service says so and it is on (nil otherwise).
    public static func nextRun(_ w: Watcher) -> Timestamp? {
        w.enabled ? w.live?.nextRunAt : nil
    }

    /// "in 5m" for a time ahead of `now` (ms).
    public static func until(_ ts: Double, now: Double) -> String {
        let s = Int(((ts - now) / 1000).rounded())
        if s < 10 { return "now" }
        if s < 60 { return "in \(s)s" }
        let m = Int((Double(s) / 60).rounded())
        if m < 60 { return "in \(m)m" }
        let h = Int((Double(m) / 60).rounded())
        return h < 24 ? "in \(h)h" : "in \(Int((Double(h) / 24).rounded()))d"
    }

    /// The owner tag for the All chief's list: the other chief's name, nil for the viewer's own or
    /// an unowned watcher.
    public static func owner(_ w: Watcher, viewer: Cos, chiefName: (String) -> String?) -> String? {
        guard let id = w.cosId.optional, id != viewer.ticketId else { return nil }
        return chiefName(id)
    }
}
