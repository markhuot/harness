import Foundation

// Port of shared/src/state/watchers.ts: watcher status for the Inbox's watcher strip, one label,
// tone and detail line per watcher.

public typealias WatcherTone = Format.Tone

public struct WatcherStatus: Codable, Sendable, Equatable {
    public var label: String
    public var tone: WatcherTone
    /// When it started, or when it runs next ("started 5m ago", "retrying in 2m")
    public var detail: String
    /// The last run's error, shown under the status
    @Nullable public var error: String?

    public init(label: String, tone: WatcherTone, detail: String, error: String?) {
        self.label = label
        self.tone = tone
        self.detail = detail
        self.error = error
    }
}

extension Watchers {
    /// "in 45s" / "in 3m" / "in 2h" for a future time; "now" once it's due. Each unit rounds from
    /// the previous one, as in TS.
    public static func untilTime(_ ts: Double, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
        let s = JSCompat.round((ts - now) / 1000)
        if s <= 0 { return "now" }
        if s < 60 { return "in \(JSCompat.string(s))s" }
        let m = JSCompat.round(s / 60)
        if m < 60 { return "in \(JSCompat.string(m))m" }
        let h = JSCompat.round(m / 60)
        if h < 24 { return "in \(JSCompat.string(h))h" }
        return "in \(JSCompat.string(JSCompat.round(h / 24)))d"
    }

    /// What a watcher is doing, for people: running, waiting for its next run, or failed and waiting
    /// to retry. Paused watchers are muted. A service that doesn't report the process state (older
    /// builds) falls back to the last run and its error.
    public static func watcherStatus(_ w: Watcher, now: Double = Date().timeIntervalSince1970 * 1000) -> WatcherStatus {
        let error = nonEmpty(w.lastError)
        if !w.enabled {
            return WatcherStatus(label: "Paused", tone: .neutral, detail: "last run \(Format.relativeTime(w.lastRunAt, now: now))", error: nil)
        }
        guard let live = w.live else {
            return WatcherStatus(
                label: error != nil ? "Failed" : "Enabled", tone: error != nil ? .red : .neutral,
                detail: "last run \(Format.relativeTime(w.lastRunAt, now: now))", error: error
            )
        }
        if live.state == .running {
            return WatcherStatus(label: "Running", tone: .green, detail: "started \(Format.relativeTime(live.since, now: now))", error: nil)
        }
        if live.state == .stopped {
            return WatcherStatus(label: "Stopped", tone: error != nil ? .red : .neutral, detail: "stopped \(Format.relativeTime(live.since, now: now))", error: error)
        }
        // `live.nextRunAt ? …`: 0 is falsy too.
        let next = live.nextRunAt.flatMap { $0 != 0 && !$0.isNaN ? untilTime($0, now: now) : nil }
        if let error {
            let label = live.failures > 1 ? "Failed \(live.failures)× in a row" : "Failed"
            return WatcherStatus(label: label, tone: .red, detail: next.map { "retrying \($0)" } ?? "restarting", error: error)
        }
        return WatcherStatus(label: "Waiting", tone: .neutral, detail: next.map { "next run \($0)" } ?? "starting", error: nil)
    }
}
