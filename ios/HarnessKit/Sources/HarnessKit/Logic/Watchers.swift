import Foundation

// Port of shared/src/watchers.ts: watcher command lines, Inbox titles for raw output, and the
// driver/model a watcher's triage sessions use (the combined Model select and what it saves).
//
// JS semantics kept: `||` skips nil *and* "" (`nonEmpty`); SAFE_WORD and the line split work on
// code units / scalars, not Swift Characters ("\r\n" is one Character); `\p{L}\p{N}` (with the `u`
// flag) is a general-category test on scalars; `.length`/`.slice` count UTF-16 code units.

/// The settings fields watcher triage reads. `Settings` and `PublicSettings` both conform.
public protocol WatcherTriageSettings {
    var defaultDriver: String { get }
    var watcherDriver: Patch<String> { get }
    var defaultModels: [String: String?] { get }
    var watcherModels: [String: String?]? { get }
}

extension Settings: WatcherTriageSettings {}
extension PublicSettings: WatcherTriageSettings {}

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

    // MARK: Triage driver and model

    /// The driver a watcher's triage sessions run on: its own, else settings.watcherDriver, else
    /// settings.defaultDriver.
    public static func watcherDriver(_ driver: String?, watcherDriver: String?, defaultDriver: String) -> String {
        nonEmpty(driver) ?? nonEmpty(watcherDriver) ?? defaultDriver
    }

    public static func watcherDriver(_ w: Watcher?, settings: some WatcherTriageSettings) -> String {
        watcherDriver(w?.driver, watcherDriver: settings.watcherDriver.optional, defaultDriver: settings.defaultDriver)
    }

    /// The model a watcher's triage sessions use on `driver`. First set wins: the watcher's
    /// models[driver], settings.watcherModels[driver], settings.defaultModels[driver]; nil → the
    /// driver's own default. Pass `models: nil` for what a watcher without its own model falls back
    /// to (and for injected output, which has no watcher).
    public static func watcherModel(
        _ driver: String, models: [String: String?]?, watcherModels: [String: String?]?, defaultModels: [String: String?]?
    ) -> String? {
        nonEmpty(models?[driver] ?? nil) ?? nonEmpty(watcherModels?[driver] ?? nil) ?? nonEmpty(defaultModels?[driver] ?? nil)
    }

    public static func watcherModel(_ driver: String, watcher: Watcher?, settings: (any WatcherTriageSettings)?) -> String? {
        watcherModel(driver, models: watcher?.models.map(optionalValues), watcherModels: settings?.watcherModels, defaultModels: settings?.defaultModels)
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

    /// What a watcher's Model select shows as picked. A watcher with its own driver shows that
    /// driver and its model there. One without a driver but with a model for the default watcher
    /// driver (set through the tools) shows that pick; otherwise Default. No watcher at all is
    /// `driver: nil, models: nil`, which is Default too.
    public static func watcherChoice(driver: String?, models: [String: String?]?, watcherDriver settingsDriver: String?, defaultDriver: String) -> TriageChoice {
        if let own = nonEmpty(driver) { return TriageChoice(driver: own, model: nonEmpty(models?[own] ?? nil)) }
        let fallback = watcherDriver(nil, watcherDriver: settingsDriver, defaultDriver: defaultDriver)
        guard let model = nonEmpty(models?[fallback] ?? nil) else { return defaultTriageChoice }
        return TriageChoice(driver: fallback, model: model)
    }

    public static func watcherChoice(_ w: Watcher?, settings: some WatcherTriageSettings) -> TriageChoice {
        watcherChoice(
            driver: w?.driver, models: w?.models.map(optionalValues), watcherDriver: settings.watcherDriver.optional,
            defaultDriver: settings.defaultDriver
        )
    }

    /// A PATCH body for a per-driver models map: every stored driver gets nil (cleared), then
    /// `keep` sets one (its model may be nil: that driver's own default).
    public static func replaceModels(_ current: [String: String?]?, keep: TriageChoice) -> [String: String?] {
        var out = (current ?? [:]).mapValues { _ in String?.none }
        // `.some(model)` spells out what the subscript does: a nil model stores an explicit null
        // (a literal `out[driver] = nil` would remove the key instead).
        if let driver = nonEmpty(keep.driver) { out[driver] = .some(keep.model) }
        return out
    }

    /// The driver and models fields that save a pick on a watcher. The pick replaces whatever the
    /// watcher had: other drivers' models are cleared, so Default really inherits both and a
    /// pinned driver has exactly one model entry.
    public static func watcherChoiceBody(_ choice: TriageChoice, currentModels: [String: String?]?) -> WatcherBody {
        WatcherBody(driver: Patch(choice.driver), models: replaceModels(currentModels, keep: choice))
    }

    public static func watcherChoiceBody(_ choice: TriageChoice, current: Watcher?) -> WatcherBody {
        watcherChoiceBody(choice, currentModels: current?.models.map(optionalValues))
    }

    /// What the settings-level watcher Model select shows as picked (Default follows
    /// defaultDriver/defaultModels).
    public static func settingsWatcherChoice(watcherDriver settingsDriver: String?, defaultDriver: String, watcherModels: [String: String?]?) -> TriageChoice {
        let driver = nonEmpty(settingsDriver) ?? defaultDriver
        let model = nonEmpty(watcherModels?[driver] ?? nil)
        if nonEmpty(settingsDriver) != nil { return TriageChoice(driver: driver, model: model) }
        guard let model else { return defaultTriageChoice }
        return TriageChoice(driver: driver, model: model)
    }

    public static func settingsWatcherChoice(_ settings: some WatcherTriageSettings) -> TriageChoice {
        settingsWatcherChoice(watcherDriver: settings.watcherDriver.optional, defaultDriver: settings.defaultDriver, watcherModels: settings.watcherModels)
    }

    /// The PATCH /settings body that saves a pick as the default for watchers (other drivers'
    /// entries cleared).
    public static func settingsWatcherChoicePatch(_ choice: TriageChoice, watcherModels: [String: String?]?) -> SettingsPatch {
        SettingsPatch(watcherDriver: Patch(choice.driver), watcherModels: replaceModels(watcherModels, keep: choice))
    }

    public static func settingsWatcherChoicePatch(_ choice: TriageChoice, settings: some WatcherTriageSettings) -> SettingsPatch {
        settingsWatcherChoicePatch(choice, watcherModels: settings.watcherModels)
    }

    // MARK: Helpers

    static func optionalValues(_ m: [String: String]) -> [String: String?] { m.mapValues { $0 } }

    /// JS truthiness for an optional string: nil and "" are both unset.
    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}
