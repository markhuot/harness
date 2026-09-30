import Foundation

public struct Watcher: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// What to run. With no args (the normal case) this is one shell command line, run through the
    /// user's login shell (`$SHELL -lc <command>`), so PATH, pipes and `while true; do …; done`
    /// loops work. With args (watchers created before prompts existed) it is an executable that is
    /// spawned directly with those args and no shell. Whatever it prints on stdout becomes Inbox items.
    public var command: String
    /// Legacy direct-exec arguments; empty for shell command lines. See `command`.
    public var args: [String]
    /// What the triage agent should do with this watcher's output, in the user's words ("" → none).
    public var prompt: String
    @Nullable public var cwd: String?
    public var env: [String: String]
    /// "loop": run, read output until exit, re-run immediately (for blocking or long-running
    /// commands). Each burst of output becomes one Inbox item.
    /// "interval": run every intervalSec seconds. Each run's output becomes one Inbox item.
    public var mode: WatcherMode
    public var intervalSec: Int
    public var enabled: Bool
    /// Driver used for triage sessions spawned from this watcher (null → settings.watcherDriver, then settings.defaultDriver)
    @Nullable public var driver: String?
    /// Model per driver id for this watcher's triage sessions. Missing → settings.watcherModels, then
    /// settings.defaultModels, then the driver's own default. PATCH merges per driver; null clears.
    /// Optional so clients tolerate an older service without it.
    public var models: [String: String]?
    @Nullable public var lastRunAt: Timestamp?
    @Nullable public var lastError: String?
    public var createdAt: Timestamp
    public var updatedAt: Timestamp
    /// What the watcher's process is doing right now. Not stored: the service fills it in from its
    /// supervisor. Absent from services that don't report it (older builds, watchers switched off).
    public var live: WatcherLive?

    public init(
        id: String, name: String, command: String, args: [String] = [], prompt: String = "", cwd: String? = nil,
        env: [String: String] = [:], mode: WatcherMode, intervalSec: Int, enabled: Bool, driver: String? = nil,
        models: [String: String]? = nil, lastRunAt: Timestamp? = nil, lastError: String? = nil,
        createdAt: Timestamp, updatedAt: Timestamp, live: WatcherLive? = nil
    ) {
        self.id = id
        self.name = name
        self.command = command
        self.args = args
        self.prompt = prompt
        self.cwd = cwd
        self.env = env
        self.mode = mode
        self.intervalSec = intervalSec
        self.enabled = enabled
        self.driver = driver
        self.models = models
        self.lastRunAt = lastRunAt
        self.lastError = lastError
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.live = live
    }
}

/// A watcher's process state. `running`: a process is alive (since `since`). `waiting`: between
/// runs; `nextRunAt` is the next interval tick or the loop's restart after its delay or failure
/// backoff (null while it waits on a previous process to stop). `stopped`: not supervised (disabled,
/// deleted, or the service is shutting down). Whether the last run failed is `Watcher.lastError`.
public struct WatcherLive: Codable, Sendable, Equatable {
    public var state: WatcherLiveState
    /// When this state began (ms)
    public var since: Timestamp
    @Nullable public var nextRunAt: Timestamp?
    /// Consecutive failed runs; 0 after a clean exit
    public var failures: Int

    public init(state: WatcherLiveState, since: Timestamp, nextRunAt: Timestamp? = nil, failures: Int = 0) {
        self.state = state
        self.since = since
        self.nextRunAt = nextRunAt
        self.failures = failures
    }
}
