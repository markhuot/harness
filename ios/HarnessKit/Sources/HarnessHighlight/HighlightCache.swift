import Foundation
import Synchronization

/// highlightCached's memo (ios/Tools/highlighter/highlight.ts): finished highlights per (code, lang, theme,
/// diff), least recently used dropped past `capacity`. "Nothing to color it with" (nil) is cached
/// too, so a plain block isn't re-tried on every render. Thread-safe and synchronous, so a view can
/// draw a cached result in its first frame instead of flashing plain text.
public final class HighlightCache: Sendable {
    public struct Key: Hashable, Sendable {
        public var code: String
        public var language: String?
        public var theme: String
        public var diff: Bool

        public init(code: String, language: String?, theme: String, diff: Bool) {
            self.code = code
            self.language = language
            self.theme = theme
            self.diff = diff
        }
    }

    private struct State {
        var entries: [Key: (value: Highlighted?, used: UInt64)] = [:]
        var clock: UInt64 = 0
    }

    public let capacity: Int
    private let state = Mutex(State())

    public init(capacity: Int = 200) {
        self.capacity = capacity
    }

    /// A finished highlight for these inputs: `.some(nil)` when it's cached as plain, nil when it
    /// isn't cached (yet). A hit counts as a use.
    public func get(_ key: Key) -> Highlighted?? {
        state.withLock { s in
            guard let hit = s.entries[key] else { return nil }
            s.clock += 1
            s.entries[key] = (hit.value, s.clock)
            return .some(hit.value)
        }
    }

    public func set(_ key: Key, _ value: Highlighted?) {
        state.withLock { s in
            s.clock += 1
            s.entries[key] = (value, s.clock)
            while s.entries.count > capacity, let oldest = s.entries.min(by: { $0.value.used < $1.value.used })?.key {
                s.entries[oldest] = nil
            }
        }
    }

    public var count: Int { state.withLock { $0.entries.count } }

    public func removeAll() {
        state.withLock { $0.entries.removeAll() }
    }
}
