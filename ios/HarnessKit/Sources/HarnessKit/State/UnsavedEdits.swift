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

    public init() {}

    private func key(_ root: FileRoot, _ path: String) -> String {
        switch root {
        case let .ticket(k): "ticket:\(k):\(path)"
        case let .project(id): "project:\(id):\(path)"
        }
    }

    public func keep(_ root: FileRoot, path: String, contents: String, saved: String?, error: String?) {
        entries[key(root, path)] = Entry(contents: contents, saved: saved, error: error)
    }

    /// The kept edits for the file, handed over once.
    public func take(_ root: FileRoot, path: String) -> Entry? {
        entries.removeValue(forKey: key(root, path))
    }

    public func has(_ root: FileRoot, path: String) -> Bool { entries[key(root, path)] != nil }
}
