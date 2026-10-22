import Foundation

// Port of shared/src/watchers.ts: watcher command lines, Inbox titles for raw output, and the
// driver/model pick the Model select uses (`TriageChoice`) and what it saves.
//
// JS semantics kept: `||` skips nil *and* "" (`nonEmpty`); SAFE_WORD and the line split work on
// code units / scalars, not Swift Characters ("\r\n" is one Character); `\p{L}\p{N}` (with the `u`
// flag) is a general-category test on scalars; `.length`/`.slice` count UTF-16 code units.

public enum Watchers {
    // MARK: Command lines

    /// Quote one word for a POSIX shell, leaving plain words (paths, flags) as they are.
    public static func shellQuote(_ word: String) -> String {
        let scalars = word.unicodeScalars
        if !scalars.isEmpty, scalars.allSatisfy(isSafeWordScalar) { return word }
        // Replace per scalar: a "'" followed by a combining mark is still a quote to the shell.
        var out = String.UnicodeScalarView(["'"])
        for c in scalars {
            if c == "'" { out.append(contentsOf: "'\\''".unicodeScalars) } else { out.append(c) }
        }
        out.append("'")
        return String(out)
    }

    /// `/^[A-Za-z0-9_\-.,/:=@%+~]+$/`
    static func isSafeWordScalar(_ c: Unicode.Scalar) -> Bool {
        switch c {
        case "A"..."Z", "a"..."z", "0"..."9": true
        default: "_-.,/:=@%+~".unicodeScalars.contains(c)
        }
    }

    /// The watcher's command as one shell command line. Shell watchers (no args) already are one;
    /// legacy direct-exec watchers get their executable and args quoted and joined. Forms edit this
    /// line and save it back with `args: []`, which turns a legacy watcher into a shell watcher.
    public static func watcherCommandLine(command: String, args: [String]?) -> String {
        guard let args, !args.isEmpty else { return command }
        return ([command] + args).map(shellQuote).joined(separator: " ")
    }

    public static func watcherCommandLine(_ w: Watcher) -> String {
        watcherCommandLine(command: w.command, args: w.args)
    }

    // MARK: Inbox titles

    /// Longest title derived from watcher output, in UTF-16 code units (JS `.length`).
    public static let outputTitleMax = 80

    /// A readable Inbox title for raw watcher output: its first line with any letters or digits,
    /// whitespace collapsed, cut at `outputTitleMax` with an ellipsis. Triage may replace it.
    public static func outputTitle(_ text: String) -> String {
        // split(/\r?\n/): split on \n, then drop the one \r that may precede it.
        let lines = Array(text.unicodeScalars).split(separator: "\n", omittingEmptySubsequences: false).map { line -> ArraySlice<Unicode.Scalar> in
            line.last == "\r" ? line.dropLast() : line
        }
        // Skip lines with nothing readable, like the "{" that opens pretty-printed JSON.
        let line = lines.first { $0.contains(where: isLetterOrNumber) } ?? []
        var collapsed = String.UnicodeScalarView()
        var inSpace = false
        for c in line {
            if JSCompat.isWhitespace(c) {
                if !inSpace { collapsed.append(" ") }
                inSpace = true
            } else {
                collapsed.append(c)
                inSpace = false
            }
        }
        let flat = JSCompat.trim(String(collapsed))
        if flat.isEmpty { return "Watcher output" }
        let units = Array(flat.utf16)
        guard units.count > outputTitleMax else { return flat }
        // A cut through a surrogate pair leaves a lone surrogate in JS; Swift strings can't hold
        // one, so it decodes as U+FFFD.
        let head = String(decoding: units.prefix(outputTitleMax - 1), as: UTF16.self)
        return trimEndJS(head) + "…"
    }

    /// `\p{L}` or `\p{N}`.
    static func isLetterOrNumber(_ c: Unicode.Scalar) -> Bool {
        switch c.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            true
        default:
            false
        }
    }

    /// `String.prototype.trimEnd()`.
    static func trimEndJS(_ s: String) -> String {
        var scalars = Substring(s).unicodeScalars[...]
        while let l = scalars.last, JSCompat.isWhitespace(l) { scalars.removeLast() }
        return String(String.UnicodeScalarView(scalars))
    }

    // MARK: The Model select

    /// One pick from the combined Model select: a driver plus a model on it. `driver: nil` is the
    /// Default option (inherit both); `model: nil` with a driver means that driver's own default.
    public struct TriageChoice: Codable, Sendable, Equatable, Hashable {
        public var driver: String?
        public var model: String?
        public init(driver: String?, model: String?) {
            self.driver = driver
            self.model = model
        }
    }

    /// DEFAULT_TRIAGE_CHOICE.
    public static let defaultTriageChoice = TriageChoice(driver: nil, model: nil)

    /// A PATCH body for a per-driver models map: every stored driver gets nil (cleared), then
    /// `keep` sets one (its model may be nil: that driver's own default).
    public static func replaceModels(_ current: [String: String?]?, keep: TriageChoice) -> [String: String?] {
        var out = (current ?? [:]).mapValues { _ in String?.none }
        // `.some(model)` spells out what the subscript does: a nil model stores an explicit null
        // (a literal `out[driver] = nil` would remove the key instead).
        if let driver = nonEmpty(keep.driver) { out[driver] = .some(keep.model) }
        return out
    }

    // MARK: Helpers

    static func optionalValues(_ m: [String: String]) -> [String: String?] { m.mapValues { $0 } }

    /// JS truthiness for an optional string: nil and "" are both unset.
    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}
