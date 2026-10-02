import Foundation

// What the Changes tab draws for one file, row by row: its hunks' lines, and the unchanged lines
// between them as collapsed gaps ("12 unmodified lines") that expand from the file's contents (the
// plugin's /file?side=new, as @pierre/diffs' hunk separators do). Also the copy around the diff:
// file decorations, the empty states, notices and the header. Pure, so the view only draws.

/// A run of unchanged lines the diff leaves out: before hunk `index`, or after the last hunk when
/// `index` == the hunk count.
public struct ChangesGap: Sendable, Equatable, Hashable {
    public var index: Int
    /// First line of the gap on each side (1-based)
    public var newStart: Int
    public var oldStart: Int
    /// Lines in the gap; nil after the last hunk until the file's contents are loaded
    public var count: Int?
    /// The context git printed on the next hunk's header (its enclosing function)
    public var context: String?
}

public enum ChangesRow: Sendable, Equatable {
    case gap(ChangesGap)
    case line(ChangesLine)
}

/// One split-view row: the old side on the left, the new on the right. A change block pairs its
/// removed and added lines in order; context lines sit on both sides.
public struct ChangesSplitRow: Sendable, Equatable {
    public var old: ChangesLine?
    public var new: ChangesLine?
    /// Each side's position among the file's code lines (its highlighted line)
    public var oldCode: Int?
    public var newCode: Int?
}

public enum ChangesRows {
    /// The unchanged lines git puts around each change (`git diff`'s default -U3).
    public static let contextLines = 3

    /// A file's contents as lines (JS `split("\n")`, without the empty string after a final newline).
    public static func lines(of contents: String) -> [String] {
        var out = contents.components(separatedBy: "\n")
        if out.last == "" { out.removeLast() }
        return out.map { ChangesPatch.cleanLastNewline($0 + "\n") }
    }

    /// The file's rows. `contents` are the new side's lines once loaded; `expanded` holds the gap
    /// indexes the user opened (ignored until `contents` arrive). New and deleted files have no gaps.
    public static func rows(_ d: ChangesFileDiff, contents: [String]? = nil, expanded: Set<Int> = []) -> [ChangesRow] {
        guard !d.hunks.isEmpty else { return [] }
        let gaps = d.type == .new || d.type == .deleted ? false : true
        var out: [ChangesRow] = []
        var prevNew = 0
        var prevOld = 0
        func gap(_ index: Int, newStart: Int, oldStart: Int, count: Int?, context: String?) {
            guard gaps, count != 0 else { return }
            if let contents, expanded.contains(index) {
                let end = count.map { newStart + $0 - 1 } ?? contents.count
                guard newStart <= end else { return }
                for n in newStart...end where n - 1 < contents.count {
                    out.append(.line(ChangesLine(kind: .ctx, text: contents[n - 1], oldLine: oldStart + (n - newStart), newLine: n)))
                }
                return
            }
            out.append(.gap(ChangesGap(index: index, newStart: newStart, oldStart: oldStart, count: count, context: context)))
        }
        for (i, h) in d.hunks.enumerated() {
            let newBefore = h.additionStart - (h.additionCount == 0 ? 0 : 1)
            let oldBefore = h.deletionStart - (h.deletionCount == 0 ? 0 : 1)
            gap(i, newStart: prevNew + 1, oldStart: prevOld + 1, count: max(0, newBefore - prevNew), context: h.context)
            out.append(contentsOf: h.lines.map(ChangesRow.line))
            prevNew = newBefore + h.additionCount
            prevOld = oldBefore + h.deletionCount
        }
        // After the last hunk: unknown until the contents load, then whatever follows. Git closes a
        // hunk with `contextLines` unchanged lines unless the file ends first, so a hunk ending in
        // fewer reaches the end of the file.
        let tail = d.hunks.last!.lines.reversed().prefix { $0.kind == .ctx }.count
        if contents != nil || tail >= contextLines {
            let trailing = contents.map { max(0, $0.count - prevNew) }
            gap(d.hunks.count, newStart: prevNew + 1, oldStart: prevOld + 1, count: trailing, context: nil)
        }
        return out
    }

    /// Unified rows as split rows: each change block's removed lines beside its added ones.
    public static func split(_ rows: [ChangesRow]) -> [Either] {
        var out: [Either] = []
        var dels: [(ChangesLine, Int)] = []
        var adds: [(ChangesLine, Int)] = []
        var code = 0
        func flush() {
            for k in 0..<max(dels.count, adds.count) {
                let d = k < dels.count ? dels[k] : nil
                let a = k < adds.count ? adds[k] : nil
                out.append(.row(ChangesSplitRow(old: d?.0, new: a?.0, oldCode: d?.1, newCode: a?.1)))
            }
            dels = []
            adds = []
        }
        for r in rows {
            switch r {
            case let .gap(g):
                flush()
                out.append(.gap(g))
            case let .line(l):
                switch l.kind {
                case .del: dels.append((l, code))
                case .add: adds.append((l, code))
                case .ctx:
                    flush()
                    out.append(.row(ChangesSplitRow(old: l, new: l, oldCode: code, newCode: code)))
                }
                code += 1
            }
        }
        flush()
        return out
    }

    public enum Either: Sendable, Equatable {
        case gap(ChangesGap)
        case row(ChangesSplitRow)
    }

    // MARK: Highlighting

    /// The rows' code as a unified diff for the highlighter: a header naming the file (it picks the
    /// language by path) and one correctly counted hunk per run of lines between gaps, so every
    /// line is read as the kind it is.
    public static func highlightSource(_ rows: [ChangesRow], path: String) -> String {
        var out = ["diff --git a/\(path) b/\(path)", "--- a/\(path)", "+++ b/\(path)"]
        var run: [ChangesLine] = []
        func flush() {
            guard !run.isEmpty else { return }
            let old = run.filter { $0.kind != .add }.count
            let new = run.filter { $0.kind != .del }.count
            out.append("@@ -1,\(old) +1,\(new) @@")
            for l in run { out.append((l.kind == .add ? "+" : l.kind == .del ? "-" : " ") + l.text) }
            run = []
        }
        for r in rows {
            switch r {
            case .gap: flush()
            case let .line(l): run.append(l)
            }
        }
        flush()
        return out.joined(separator: "\n")
    }

    // MARK: Copy

    /// A file row's decoration (main.ts `fileDecoration`): its line counts, or what kind of change
    /// it is when there are none.
    public static func decoration(_ f: ChangedFile) -> (text: String, label: String)? {
        if f.binary { return ("bin", "Binary file") }
        if f.status == .renamed && f.additions == 0 && f.deletions == 0 {
            guard let old = f.oldPath else { return nil }
            return ("moved", "Renamed from \(old)")
        }
        return ("+\(f.additions) −\(f.deletions)", "\(f.additions) \(f.additions == 1 ? "addition" : "additions"), \(f.deletions) \(f.deletions == 1 ? "deletion" : "deletions")")
    }

    /// The one-letter status badge.
    public static func statusLetter(_ s: ChangedFileStatus) -> String {
        switch s {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .untracked: "U"
        case .unknown: "?"
        }
    }

    public static func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }

    /// The empty state when nothing changed (main.ts render).
    public static func emptyState(_ c: Changes) -> (title: String, detail: String) {
        switch c.mode {
        case .branch:
            ("No changes yet", "\(c.branch ?? "This branch") matches \(c.base ?? "its base") and the worktree is clean. Changes appear here as the agent edits files.")
        case .pinned:
            ("No changes", "\(c.branch ?? "This branch") didn't change anything before its worktree was removed.")
        default:
            ("No changes yet", "The working tree is clean. Changes appear here as the agent edits files.")
        }
    }

    /// Notices above the files: a truncated diff, a failed refresh over data already shown.
    public static func notices(_ c: Changes?, error: String?) -> [String] {
        var out: [String] = []
        if let c, c.truncated { out.append("This diff is large, so only the first part is shown. \(plural(c.files.count, "file")) changed in total.") }
        if let error, c != nil { out.append("Refresh failed: \(error)") }
        return out
    }

    /// What a file without drawable lines shows instead of a diff.
    public static func placeholder(_ f: ChangedFile, diff: ChangesFileDiff?) -> String? {
        if f.binary { return "Binary file not shown" }
        guard let diff else { return "This file's diff is past the size limit, so it isn't shown." }
        if !diff.hunks.isEmpty { return nil }
        switch diff.type {
        case .renamePure: return "Renamed without changes"
        case .new: return "Empty file"
        case .deleted: return "Empty file deleted"
        default: return diff.mode != diff.prevMode && diff.prevMode != nil ? "Mode changed from \(diff.prevMode!) to \(diff.mode ?? "?")" : "No content changes"
        }
    }

    /// "5m ago" (main.ts relTime).
    public static func relTime(_ ms: Double, now: Double) -> String {
        let s = JSCompat.round((now - ms) / 1000)
        if s < 60 { return "just now" }
        let m = JSCompat.round(s / 60)
        if m < 60 { return "\(Int(m))m ago" }
        let h = JSCompat.round(m / 60)
        if h < 24 { return "\(Int(h))h ago" }
        return "\(Int(JSCompat.round(h / 24)))d ago"
    }

    /// The first 7 characters of a sha.
    public static func short(_ sha: String?) -> String? { sha.map { String($0.prefix(7)) } }
}
