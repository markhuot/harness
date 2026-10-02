import Foundation

// The file viewer screen's decisions that don't draw: its title and subtitle, the info bar's
// badges and meta line, the Diff tab's counts, which state the file and diff bodies are in, the
// error copy, and the "More" menu's link. The viewer's other pure parts (windows, patch rows,
// sizes) are in FileViewer.swift.

/// What the file body shows (FileBody's early returns, in order).
public enum FileBodyState: Equatable, Sendable {
    /// "Too large to show", with its message
    case tooLarge(String)
    /// "Binary file", with its message
    case binary(String)
    case empty
    /// The lines, with the "changed while it was read" note above them when `truncated`
    case lines(truncated: Bool)
}

/// What the Diff tab shows (DiffBody's early returns, in order).
public enum DiffBodyState: Equatable, Sendable {
    case loading
    case error(FileLoadError)
    /// The diff is over 4 MB
    case tooLarge
    /// The patch is empty: the file matches the last commit
    case noChanges
    /// A patch with no hunks
    case binary
    case rows
}

/// The Untracked / Modified badge; an ignored file gets its own badge beside it.
public enum FileGitBadge: Equatable, Sendable {
    case untracked, modified
}

/// A failed load: the service's status (nil for a network error) and message.
public struct FileLoadError: Equatable, Sendable, Error {
    public var status: Int?
    public var message: String

    public init(status: Int?, message: String) {
        self.status = status
        self.message = message
    }

    /// A failed load: a HarnessAPIError keeps its status; anything else is a status-less message.
    public init(_ error: any Error) {
        self.init(status: (error as? HarnessAPIError)?.status, message: localizedErrorMessage(error))
    }
}

/// An error state's copy (LoadError): an icon name, a title, a message, and whether it offers Try again.
public struct FileErrorCopy: Equatable, Sendable {
    public var icon: String
    public var title: String
    public var message: String
    public var retry: Bool
}

public enum FileViewerRules {
    /// Lines are laid out this many characters wide at most; longer ones are clipped.
    public static let maxColumns = 400
    /// Characters of a long file tokenized at once (the highlighter's cap is 60 000).
    public static let windowChars = 40_000

    /// The header title: the path's last segment (`path.split("/").filter(Boolean).pop() ?? path`).
    public static func fileName(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? path
    }

    /// The header subtitle: the ticket key, else the project's name ("Project" when it isn't loaded).
    public static func subtitle(_ root: FileRoot, projectName: String?) -> String {
        switch root {
        case let .ticket(key): key
        case .project: projectName ?? "Project"
        }
    }

    /// Tabs as 4 spaces, as the viewer draws them.
    public static func expandTabs(_ s: String) -> String {
        s.contains("\t") ? s.replacingOccurrences(of: "\t", with: "    ") : s
    }

    /// A line's drawn width in characters: UTF-16 units after tabs expand.
    public static func drawnLength(_ line: String) -> Int {
        var n = 0
        for u in line.utf16 { n += u == 0x09 ? 4 : 1 }
        return n
    }

    /// Only a file git says changed has a diff (and outside a repository the endpoint is a 409).
    public static func hasDiff(_ view: FileView) -> Bool { view.git.repo && view.git.dirty }

    public static func gitBadge(_ git: FileGitState) -> FileGitBadge? {
        git.untracked ? .untracked : git.dirty ? .modified : nil
    }

    /// "1.2 KB · 40 lines · lines 3–9": the size, the line count and the linked range, each when known.
    public static func meta(size: Int?, lineCount: Int?, range: ClosedRange<Int>?) -> String {
        var parts: [String] = []
        if let size { parts.append(FileViewer.formatSize(Double(size))) }
        if let lineCount { parts.append("\(lineCount) line\(lineCount == 1 ? "" : "s")") }
        if let range {
            parts.append(range.lowerBound == range.upperBound ? "line \(range.lowerBound)" : "lines \(range.lowerBound)–\(range.upperBound)")
        }
        return parts.joined(separator: " · ")
    }

    /// The Diff tab's counts: added and removed lines.
    public static func diffCounts(_ rows: [PatchRow]) -> (added: Int, removed: Int) {
        rows.reduce(into: (0, 0)) { n, r in
            if r.kind == .add { n.0 += 1 } else if r.kind == .del { n.1 += 1 }
        }
    }

    /// "+3 −1", "+3" or "−1"; nil with no changed lines.
    public static func diffCountLabel(added: Int, removed: Int) -> String? {
        let parts = [added > 0 ? "+\(added)" : nil, removed > 0 ? "−\(removed)" : nil].compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    public static func fileBody(_ view: FileView) -> FileBodyState {
        if view.tooLarge { return .tooLarge("This file is \(FileViewer.formatSize(Double(view.size))); the viewer opens files up to 2 MB.") }
        guard !view.binary, let contents = view.contents else { return .binary("\(FileViewer.formatSize(Double(view.size))) of binary data.") }
        if contents.isEmpty { return .empty }
        return .lines(truncated: view.truncated)
    }

    /// `diff` nil means it hasn't started loading , which shows the spinner too.
    public static func diffBody(_ diff: FileLoad<FileDiff>?, rows: [PatchRow]) -> DiffBodyState {
        switch diff {
        case nil, .loading: return .loading
        case let .error(e): return .error(e)
        case let .ok(d):
            if d.tooLarge { return .tooLarge }
            if d.patch.isEmpty { return .noChanges }
            return rows.isEmpty ? .binary : .rows
        }
    }

    public enum LoadSubject: Sendable { case file, diff }

    public static func errorCopy(_ what: LoadSubject, _ error: FileLoadError, path: String) -> FileErrorCopy {
        if what == .file && error.status == 404 {
            return FileErrorCopy(icon: "fileText", title: "File not found", message: "\(path) isn't there. It may have been moved or deleted, or the link's path is off.", retry: false)
        }
        if what == .file && error.status == 400 {
            return FileErrorCopy(icon: "alert", title: "Can't open this path", message: error.message, retry: false)
        }
        return FileErrorCopy(icon: "alert", title: what == .file ? "Couldn't load the file" : "Couldn't load the diff", message: error.message, retry: true)
    }

    /// "Copy link": the shown path in its root, with the range (`#Lx` for one line, `#Lx-Ly` for more).
    public static func link(path: String, root: FileRoot, range: ClosedRange<Int>?) -> String {
        var link = FileLink(path: path, startLine: range?.lowerBound)
        if let range, range.upperBound != range.lowerBound { link.endLine = range.upperBound }
        switch root {
        case let .ticket(key): link.ticketKey = key
        case let .project(id): link.projectId = id
        }
        return FileLinks.formatFileLink(link)
    }
}

/// Which lines of a long file have colors, as windows of it are highlighted around what's on screen
/// (FileBody's center / highlightWindow / colored map). Colored lines pile up, so scrolling back
/// never goes plain again; `reset()` drops them when the syntax theme changes.
public struct FileHighlightWindows<Colors> {
    public let lengths: [Int]
    public let maxChars: Int
    /// The window to highlight now: [from, to) line indexes
    public private(set) var window: Range<Int>
    public private(set) var colored: [Int: Colors] = [:]

    /// `center` is 0-based: the range's first line, or 0.
    public init(lengths: [Int], center: Int, maxChars: Int = FileViewerRules.windowChars) {
        self.lengths = lengths
        self.maxChars = maxChars
        window = FileViewer.highlightWindow(lengths: lengths, center: center, maxChars: maxChars)
    }

    /// The rows on screen changed. When some fall outside the window, it moves to center on them
    /// (`Math.round((first + last) / 2)`); returns whether it moved.
    @discardableResult
    public mutating func visible(first: Int, last: Int) -> Bool {
        guard first < window.lowerBound || last >= window.upperBound else { return false }
        let next = FileViewer.highlightWindow(lengths: lengths, center: (first + last + 1) / 2, maxChars: maxChars)
        guard next != window else { return false }
        window = next
        return true
    }

    /// A highlight of `lines[from ..< from + colors.count]` landed.
    public mutating func land(_ colors: [Colors], from: Int) {
        for (i, c) in colors.enumerated() where from + i < lengths.count { colored[from + i] = c }
    }

    public mutating func reset() { colored = [:] }
}

/// A file's text as the viewer lists it: its lines, each line's drawn width, and the widest.
public struct FileText: Sendable, Equatable {
    public let lines: [String]
    /// `drawnLength` of each line
    public let lengths: [Int]
    public let longest: Int

    public init(_ contents: String) {
        lines = FileViewer.fileLines(contents)
        lengths = lines.map(FileViewerRules.drawnLength)
        longest = lengths.max() ?? 0
    }
}
