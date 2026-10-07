import Foundation

// The decisions behind Settings, Project settings and the watcher rows, pulled out of the SwiftUI
// views so they can be tested: labels, what a committed field saves, counts and confirm copy.

public enum SettingsRules {
    // MARK: Network

    /// LISTEN_LABEL
    public static func listenLabel(_ mode: ListenMode) -> String {
        switch mode {
        case .localhost: "This Mac only"
        case .tailscale: "Tailscale"
        case .any: "All networks"
        case .custom: "Custom address"
        case let .unknown(raw): raw
        }
    }

    /// The modes "Listen on" offers: LISTEN_MODES without custom (only the Mac sets one).
    public static let listenChoices: [ListenMode] = ListenMode.allKnown.filter { $0 != .custom }

    /// The select's text: a custom address shows as "Custom · host".
    public static func listenTriggerLabel(_ net: NetworkStatus) -> String {
        net.mode == .custom ? "Custom · \(net.host ?? "")" : listenLabel(net.mode)
    }

    public static func networkFooter(_ net: NetworkStatus) -> String {
        if let o = net.override, !o.isEmpty { return "HARNESS_HOST=\(o) overrides this setting." }
        return "Where the service accepts connections. The phone needs Tailscale or All networks."
    }

    /// A bound address without its scheme (`/^https?:\/\//`).
    public static func boundLabel(_ url: String) -> String {
        for prefix in ["http://", "https://"] where url.hasPrefix(prefix) { return String(url.dropFirst(prefix.count)) }
        return url
    }

    public enum ListenChange: Equatable, Sendable {
        /// The current mode: nothing to send.
        case none
        /// Localhost cuts this phone off: confirm first.
        case confirm
        case apply
    }

    public static func listenChange(from current: ListenMode, to next: ListenMode) -> ListenChange {
        if next == current { return .none }
        return next == .localhost ? .confirm : .apply
    }

    // MARK: General

    /// Max concurrent runs as typed: `Math.round(Number(v))`, clamped to 1…32; nil when it isn't a
    /// finite number (nothing is saved).
    public static func maxConcurrentRuns(_ text: String) -> Int? {
        let n = JSCompat.round(JSNumber.parse(text))
        guard n.isFinite else { return nil }
        return Int(min(32, max(1, n)))
    }

    /// Suspend unused browser tabs after N minutes, as typed: `Math.round(Number(v))`, clamped to
    /// 0…1440 (0 = never); nil when it's blank or not a finite number (nothing is saved).
    public static func browserIdleTabMinutes(_ text: String) -> Int? {
        guard !JSCompat.trim(text).isEmpty else { return nil }
        let n = JSCompat.round(JSNumber.parse(text))
        guard n.isFinite else { return nil }
        return Int(min(Double(BrowserIdleTabs.maxMinutes), max(0, n)))
    }

    /// What committing a base branch field does.
    public enum BranchCommit: Equatable, Sendable {
        case none
        /// Toast "Not a valid branch name: …"
        case invalid(String)
        /// Save it; nil clears the override (inherit).
        case save(String?)
    }

    /// Settings → General → Base branch: empty goes back to the built-in default, and an unchanged
    /// name isn't sent.
    public static func settingsBaseBranchCommit(_ text: String, current: String?) -> BranchCommit {
        let trimmed = JSCompat.trim(text)
        let name = trimmed.isEmpty ? Branches.defaultBaseBranch : trimmed
        if let error = Branches.branchNameError(name) { return .invalid(error) }
        return name == current ? .none : .save(name)
    }

    /// Project settings → Base branch: empty inherits (null); otherwise it must be a valid name.
    public static func projectBaseBranchCommit(_ text: String) -> BranchCommit {
        let name = JSCompat.trim(text)
        if name.isEmpty { return .save(nil) }
        if let error = Branches.branchNameError(name) { return .invalid(error) }
        return .save(name)
    }

    /// The API key to save, or nil when the field is blank.
    public static func apiKeyToSave(_ text: String) -> String? {
        let key = JSCompat.trim(text)
        return key.isEmpty ? nil : key
    }

    // MARK: Drivers

    public enum DriverStatus: Equatable, Sendable {
        case unavailable, signedOut, ready

        public var label: String {
            switch self {
            case .unavailable: "Unavailable"
            case .signedOut: "Not signed in"
            case .ready: "Ready"
            }
        }
    }

    public static func driverStatus(_ d: DriverInfo) -> DriverStatus {
        if !d.available { return .unavailable }
        if !d.authenticated { return .signedOut }
        return .ready
    }

    /// "Log in" / "Log in again", or nil for a driver without a login flow.
    public static func loginLabel(_ d: DriverInfo) -> String? {
        guard d.supportsLogin else { return nil }
        return d.authenticated ? "Log in again" : "Log in"
    }

    // MARK: Connection

    /// The host under a saved Mac's name, when the name isn't already the host.
    public static func serverHost(_ s: SavedServer) -> String? {
        let host = MobilePair.displayHost(s.baseUrl)
        return s.name == host ? nil : host
    }

    // MARK: Watchers

    /// Watchers by name (`localeCompare`), ties by id so the order is stable.
    public static func sortedWatchers(_ watchers: some Collection<Watcher>) -> [Watcher] {
        watchers.sorted {
            switch $0.name.localizedCompare($1.name) {
            case .orderedAscending: true
            case .orderedDescending: false
            case .orderedSame: $0.id < $1.id
            }
        }
    }

    /// "Loop" or "Every 300s".
    public static func watcherScheduleLabel(_ w: Watcher) -> String {
        w.mode == .loop ? "Loop" : "Every \(w.intervalSec)s"
    }

    /// The driver a watcher's triage runs on and, when one applies, its model (WatcherTriageLabel).
    public struct TriageTarget: Equatable, Sendable {
        /// "" when there's no driver to name
        public var driver: String
        public var model: String?
    }

    public static func watcherTriageTarget(_ w: Watcher, settings: PublicSettings?) -> TriageTarget {
        let driver = settings.map { Watchers.watcherDriver(w, settings: $0) } ?? (w.driver ?? "")
        let model = driver.isEmpty ? nil : Watchers.watcherModel(driver, watcher: w, settings: settings)
        return TriageTarget(driver: driver, model: model)
    }

    /// "Claude Code · Opus", "Claude Code", or "Default driver".
    public static func watcherTriageLabel(_ target: TriageTarget, drivers: [DriverInfo], models: [ModelInfo]?) -> String {
        let name = target.driver.isEmpty ? "Default driver" : drivers.first { $0.id == target.driver }?.name ?? target.driver
        guard let model = target.model else { return name }
        return "\(name) · \(Models.modelName(models, model))"
    }

    /// The row's last line: "<triage> · last run 5m ago · in ~/x".
    public static func watcherMetaLine(triage: String, _ w: Watcher, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
        var line = "\(triage) · last run \(Format.relativeTime(w.lastRunAt, now: now))"
        if let cwd = w.cwd, !cwd.isEmpty { line += " · in \(cwd)" }
        return line
    }

    // MARK: Project settings

    /// The identifier field as typed: upper case, at most 20 UTF-16 units (the field's length cap).
    public static func identifierDraft(_ text: String) -> String {
        var out = ""
        var units = 0
        for ch in text.uppercased() {
            let n = ch.utf16.count
            if units + n > 20 { break }
            out.append(ch)
            units += n
        }
        return out
    }

    /// How many tickets removing the project deletes: the open ones loaded on the board, plus the
    /// service's done total (done tickets page in), or the loaded done ones until that arrives.
    public static func projectTicketCount(_ projectId: String, tickets: some Collection<Ticket>, doneTotal: Int?) -> Int {
        let loaded = tickets.filter { $0.projectId == projectId }
        let open = loaded.filter { $0.status != .done }.count
        return open + (doneTotal ?? loaded.filter { $0.status == .done }.count)
    }

    private static func tickets(_ n: Int) -> String { "\(n) ticket\(n == 1 ? "" : "s")" }

    /// The Danger zone row's subtitle.
    public static func removeProjectHint(_ count: Int) -> String {
        "Deletes \(count > 0 ? "\(tickets(count)) and their history" : "the project") from Harness. Files on disk are left alone."
    }

    /// The confirm alert for Remove project.
    public static func removeProjectConfirm(name: String, key: String, count: Int) -> (title: String, message: String) {
        let what = count > 0 ? "its \(tickets(count)) and their transcripts" : "the project"
        return ("Remove \(name) (\(key))?", "This deletes \(what). Files on disk, branches and worktrees are left alone.")
    }

    /// The folder to save when the field is committed: trimmed, and only when it changed.
    public static func projectPathCommit(_ text: String, current: String) -> String? {
        let p = JSCompat.trim(text)
        return p.isEmpty || p == current ? nil : p
    }
}
