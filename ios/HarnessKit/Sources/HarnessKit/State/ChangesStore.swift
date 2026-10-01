import Foundation
import Observation

// The Changes tab's state (plugins/git/ui/main.ts ChangesView, minus the drawing): the diff and
// commit log from a ChangesSource, refreshes (queued while one runs, debounced on ticket events,
// polled while the agent works), the parsed files and their fingerprints, "viewed" marks and
// collapse toggles, the diff style, and context expanded from the files' contents.

@MainActor
@Observable
public final class ChangesStore {
    /// Ticket events arrive in bursts; refresh once they settle.
    public static let debounceMs: Double = 600
    /// File edits don't emit ticket events, so poll while the agent works.
    public static let pollMs: Double = 4000

    public let ticketKey: String
    @ObservationIgnored private let source: any ChangesSource
    @ObservationIgnored private let defaults: any ChangesDefaults
    @ObservationIgnored private let timers: any Timers
    @ObservationIgnored private let now: @MainActor () -> Double

    public private(set) var changes: Changes?
    public private(set) var log: ChangesLog?
    /// The last load's error; data already shown stays
    public private(set) var error: String?
    public private(set) var loading = false
    /// Parsed files by path, in patch order
    public private(set) var diffs: [String: ChangesFileDiff] = [:]
    /// Fingerprint of each parsed file's current diff, by path
    public private(set) var fingerprints: [String: String] = [:]
    /// Files marked viewed, persisted per ticket
    public private(set) var viewed: ChangesViewed
    /// The style picked with the Unified/Split control; nil until someone picks one
    public private(set) var chosenStyle: ChangesDiffStyle?
    public var showCommits = false
    /// New-side lines of files whose context was expanded, by path
    public private(set) var contents: [String: [String]] = [:]
    /// Expanded gap indexes, by path
    public private(set) var expanded: [String: Set<Int>] = [:]
    /// Paths whose contents are loading
    public private(set) var loadingContents: Set<String> = []
    /// Why the last expansion failed, until the next one
    public private(set) var expandError: String?

    /// This session's disclosure toggles, for the version of the diff they were made on
    @ObservationIgnored private var toggles: [String: (fingerprint: String, collapsed: Bool)] = [:]
    /// Bumped when toggles change, so views observing collapse redraw
    private var toggleVersion = 0
    @ObservationIgnored private var queued = false
    @ObservationIgnored private var patchKey = ""
    @ObservationIgnored private var debounce: TimerHandle?
    @ObservationIgnored private var poll: TimerHandle?
    @ObservationIgnored private var busy = false
    @ObservationIgnored private var active = true

    public init(ticketKey: String, source: any ChangesSource, defaults: any ChangesDefaults, timers: any Timers, now: @escaping @MainActor () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.ticketKey = ticketKey
        self.source = source
        self.defaults = defaults
        self.timers = timers
        self.now = now
        viewed = ChangesViewedStore.read(ticketKey, from: defaults)
        chosenStyle = ChangesDiffStyle.read(defaults)
    }

    // MARK: Data

    /// Load the diff and the log. While a load runs, another call queues one more after it.
    @discardableResult
    public func refresh() -> Task<Void, Never>? {
        if loading {
            queued = true
            return nil
        }
        loading = true
        let source = source
        let key = ticketKey
        return Task { @MainActor in
            do {
                async let c = source.changes(ticket: key, maxBytes: nil)
                async let l = source.log(ticket: key, limit: nil)
                let (changes, log) = try await (c, l)
                self.apply(changes)
                self.log = log
                self.error = nil
            } catch {
                self.error = Connection.describeError(error)
            }
            self.loading = false
            if self.queued {
                self.queued = false
                await self.refresh()?.value
            }
        }
    }

    private func apply(_ c: Changes) {
        changes = c
        let key = "\(c.baseSha ?? ""):\(c.patch.utf16.count):\(ChangesPatch.hash(c.patch))"
        guard key != patchKey else { return }
        patchKey = key
        let parsed = ChangesPatch.parse(c.patch)
        diffs = Dictionary(parsed.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        let fps = Dictionary(parsed.map { ($0.name, $0.fingerprint) }, uniquingKeysWith: { a, _ in a })
        // Expanded context belongs to one version of a file's diff.
        for path in Set(contents.keys).union(expanded.keys) where fps[path] != fingerprints[path] || fps[path] == nil {
            contents[path] = nil
            expanded[path] = nil
        }
        fingerprints = fps
        let pruned = ChangesViewedStore.prune(viewed, current: fps, changed: Set(c.files.map(\.path)))
        if pruned != viewed {
            viewed = pruned
            ChangesViewedStore.save(ticketKey, viewed, to: defaults, now: now())
        }
        toggles = toggles.filter { fps[$0.key] == $0.value.fingerprint }
        toggleVersion += 1
    }

    // MARK: Ticket events and polling

    /// A ticket event: refresh once events settle, and poll while the agent is busy.
    public func ticketChanged(busy: Bool) {
        if let debounce { timers.clear(debounce) }
        debounce = timers.set(Self.debounceMs) { [weak self] in
            self?.debounce = nil
            self?.refresh()
        }
        if busy != self.busy {
            self.busy = busy
            schedulePoll()
        }
    }

    /// Whether the tab is on screen (and the app in the foreground). Polls only run while it is;
    /// coming back refreshes at once.
    public func setActive(_ on: Bool) {
        guard on != active else { return }
        active = on
        if on { refresh() }
        schedulePoll()
    }

    private func schedulePoll() {
        if let poll { timers.clear(poll) }
        poll = nil
        guard busy, active else { return }
        poll = timers.set(Self.pollMs) { [weak self] in
            guard let self else { return }
            self.poll = nil
            self.refresh()
            self.schedulePoll()
        }
    }

    /// Stop timers (the tab went away).
    public func stop() {
        if let debounce { timers.clear(debounce) }
        if let poll { timers.clear(poll) }
        debounce = nil
        poll = nil
    }

    // MARK: Style

    public func style(width: Double) -> ChangesDiffStyle { ChangesDiffStyle.effective(chosen: chosenStyle, width: width) }

    public func setStyle(_ s: ChangesDiffStyle) {
        chosenStyle = s
        ChangesDiffStyle.save(s, to: defaults)
    }

    // MARK: Viewed and collapse

    public func isViewed(_ path: String) -> Bool {
        guard let fp = fingerprints[path] else { return false }
        return viewed[path] == fp
    }

    public func isCollapsed(_ path: String) -> Bool {
        _ = toggleVersion
        guard let fp = fingerprints[path] else { return false }
        let t = toggles[path]
        return ChangesViewedStore.isCollapsed(viewed: isViewed(path), toggle: t.map { ($0.fingerprint, $0.collapsed) }, fingerprint: fp)
    }

    /// Files marked viewed among the parsed ones.
    public var viewedCount: Int { fingerprints.keys.filter(isViewed).count }

    /// Mark or unmark a file. Viewing collapses it and unviewing expands it, whatever the arrow said.
    public func setViewed(_ path: String, _ on: Bool) {
        guard let fp = fingerprints[path] else { return }
        var v = viewed
        v.remove(path)
        if on { v.set(path, fp) }
        viewed = v
        toggles[path] = nil
        toggleVersion += 1
        ChangesViewedStore.save(ticketKey, viewed, to: defaults, now: now())
    }

    public func toggleCollapsed(_ path: String) {
        guard let fp = fingerprints[path] else { return }
        toggles[path] = (fp, !isCollapsed(path))
        toggleVersion += 1
    }

    // MARK: Context

    /// The rows to draw for a file.
    public func rows(_ path: String) -> [ChangesRow] {
        guard let d = diffs[path] else { return [] }
        return ChangesRows.rows(d, contents: contents[path], expanded: expanded[path] ?? [])
    }

    /// Open a gap of unchanged lines, loading the file's contents the first time.
    @discardableResult
    public func expand(_ path: String, gap: Int) -> Task<Void, Never>? {
        if contents[path] != nil {
            expanded[path, default: []].insert(gap)
            return nil
        }
        guard !loadingContents.contains(path), let d = diffs[path] else { return nil }
        loadingContents.insert(path)
        expandError = nil
        let fp = fingerprints[path]
        let source = source
        let key = ticketKey
        return Task { @MainActor in
            defer { self.loadingContents.remove(path) }
            do {
                // Context lines are the same on both sides, so the new side numbers both.
                let text = try await source.file(ticket: key, side: .new, path: d.name, ref: nil)
                // The diff moved on while this loaded: its gaps are different now.
                guard self.fingerprints[path] == fp else { return }
                self.contents[path] = ChangesRows.lines(of: text ?? "")
                self.expanded[path, default: []].insert(gap)
            } catch {
                self.expandError = Connection.describeError(error)
            }
        }
    }
}
