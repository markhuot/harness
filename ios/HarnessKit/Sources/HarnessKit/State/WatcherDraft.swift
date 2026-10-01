import Foundation

// Port of mobile/src/lib/watcherDraft.ts: the watcher form's editable draft and the request body
// it saves.

public struct WatcherDraft: Codable, Sendable, Equatable {
    public var name: String
    /// One shell command line (legacy direct-exec watchers are shown quoted and joined)
    public var command: String
    public var prompt: String
    public var cwd: String
    public var mode: WatcherMode
    /// The text field's contents; `watcherBody` parses it like JS `Number(…)`.
    public var intervalSec: String
    public var enabled: Bool
    /// The combined Model pick: a driver plus a model on it (driver nil → Default)
    public var choice: TriageChoice

    public init(
        name: String = "", command: String = "", prompt: String = "", cwd: String = "", mode: WatcherMode = .loop,
        intervalSec: String = "300", enabled: Bool = true, choice: TriageChoice = Watchers.defaultTriageChoice
    ) {
        self.name = name
        self.command = command
        self.prompt = prompt
        self.cwd = cwd
        self.mode = mode
        self.intervalSec = intervalSec
        self.enabled = enabled
        self.choice = choice
    }

    /// The settings fields the draft reads: `Pick<Settings, "defaultDriver" | "watcherDriver">`.
    public struct DriverSettings: Codable, Sendable, Equatable {
        public var defaultDriver: String
        public var watcherDriver: String?

        public init(defaultDriver: String, watcherDriver: String? = nil) {
            self.defaultDriver = defaultDriver
            self.watcherDriver = watcherDriver
        }

        public init(_ s: some WatcherTriageSettings) {
            self.init(defaultDriver: s.defaultDriver, watcherDriver: s.watcherDriver.optional)
        }
    }

    /// The draft for an existing watcher, or a blank one (loop, 300s, enabled, Default).
    public static func toDraft(_ w: Watcher?, settings: DriverSettings?) -> WatcherDraft {
        guard let w else { return WatcherDraft() }
        let choice: TriageChoice
        if let settings {
            choice = Watchers.watcherChoice(
                driver: w.driver, models: w.models.map(Watchers.optionalValues), watcherDriver: settings.watcherDriver,
                defaultDriver: settings.defaultDriver
            )
        } else if let driver = Models.nonEmpty(w.driver) {
            choice = TriageChoice(driver: driver, model: Models.nonEmpty(w.models?[driver]))
        } else {
            choice = Watchers.defaultTriageChoice
        }
        return WatcherDraft(
            name: w.name, command: Watchers.watcherCommandLine(w), prompt: w.prompt, cwd: w.cwd ?? "", mode: w.mode,
            intervalSec: String(w.intervalSec), enabled: w.enabled, choice: choice
        )
    }

    public static func toDraft(_ w: Watcher?, settings: (some WatcherTriageSettings)?) -> WatcherDraft {
        toDraft(w, settings: settings.map { DriverSettings($0) })
    }

    /// The create/update body for a draft. Always sends `args: []`, so saving a legacy direct-exec
    /// watcher turns it into a shell watcher running the (quoted) command line shown in the form. The
    /// Model pick replaces the watcher's driver and models (other drivers' stored models are cleared).
    /// `name` and `command` are always set.
    public static func watcherBody(_ d: WatcherDraft, existingModels: [String: String?]?) -> WatcherBody {
        let choice = Watchers.watcherChoiceBody(d.choice, currentModels: existingModels)
        let cwd = JSCompat.trim(d.cwd)
        return WatcherBody(
            name: JSCompat.trim(d.name), command: JSCompat.trim(d.command), args: [], prompt: JSCompat.trim(d.prompt),
            cwd: cwd.isEmpty ? .null : .value(cwd), mode: d.mode, intervalSec: intervalSec(d.intervalSec), enabled: d.enabled,
            driver: choice.driver, models: choice.models
        )
    }

    public static func watcherBody(_ d: WatcherDraft, existing: Watcher? = nil) -> WatcherBody {
        watcherBody(d, existingModels: existing?.models.map(Watchers.optionalValues))
    }

    /// `Math.max(1, Math.round(Number(s)) || 60)`. NaN and 0 fall back to 60. Infinity, which JSON
    /// writes as null, and values beyond Int's range give nil (the key is left out).
    static func intervalSec(_ s: String) -> Int? {
        let rounded = JSCompat.round(JSNumber.parse(s))
        let n = max(1, rounded.isNaN || rounded == 0 ? 60 : rounded)
        guard n.isFinite, n < 0x1p63 else { return nil }
        return Int(n)
    }
}
