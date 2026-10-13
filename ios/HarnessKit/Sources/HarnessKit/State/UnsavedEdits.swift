import Foundation

/// Edits a file's screen couldn't write when it went away (the save failed after the card was closed
/// or swiped off), held until that file opens again, so a failed save on leave never drops them.
@MainActor
public final class UnsavedEdits {
    public struct Entry: Equatable, Sendable {
        public let contents: String
        /// What the screen believed was on disk when the edits were kept
        public let saved: String?
        public let error: String?
    }

    public static let shared = UnsavedEdits()

    private var entries: [String: Entry] = [:]
    /// Screens showing each file right now.
    private var live: [String: Int] = [:]

    public init() {}

    private func key(_ root: FileRoot, _ path: String) -> String {
        switch root {
        case let .ticket(k): "ticket:\(k):\(path)"
        case let .project(id): "project:\(id):\(path)"
        }
    }

    /// A screen of the file is on screen (opened, or came back). While one is, the edits a leaving screen
    /// couldn't save aren't kept: the live screen already holds its own, and a stale entry would bring old
    /// text back on a later open.
    public func attach(_ root: FileRoot, path: String) { live[key(root, path), default: 0] += 1 }

    public func detach(_ root: FileRoot, path: String) {
        let k = key(root, path)
        let n = (live[k] ?? 0) - 1
        live[k] = n > 0 ? n : nil
    }

    /// Holds the edits for the file's next screen. False (nothing kept) when a screen of the file is live.
    @discardableResult
    public func keep(_ root: FileRoot, path: String, contents: String, saved: String?, error: String?) -> Bool {
        let k = key(root, path)
        guard live[k] == nil else { return false }
        entries[k] = Entry(contents: contents, saved: saved, error: error)
        return true
    }

    /// The file was written: whatever was kept for it is older than what's on disk now.
    public func drop(_ root: FileRoot, path: String) { entries.removeValue(forKey: key(root, path)) }

    /// The kept edits for the file, handed over once.
    public func take(_ root: FileRoot, path: String) -> Entry? {
        entries.removeValue(forKey: key(root, path))
    }

    public func has(_ root: FileRoot, path: String) -> Bool { entries[key(root, path)] != nil }
}
