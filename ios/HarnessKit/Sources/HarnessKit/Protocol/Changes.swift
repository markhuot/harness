import Foundation

// The Changes tab's payloads: Codable ports of the types in plugins/git/git.ts (ChangedFile,
// Changes, Commit) and the plugin's /log and /file responses. They aren't in protocol.ts yet; the
// git plugin serves them under /plugins/git/api/… (ChangesSource.swift). Samples live in
// shared/fixtures/cases/changes.ts and ChangesTests round-trips them.

/// How a changed file changed. Untracked files are new files git doesn't know about yet.
public enum ChangedFileStatus: OpenEnum {
    case added, modified, deleted, renamed, untracked
    case unknown(String)

    public static let allKnown: [Self] = [.added, .modified, .deleted, .renamed, .untracked]
    public var rawValue: String {
        switch self {
        case .added: "added"
        case .modified: "modified"
        case .deleted: "deleted"
        case .renamed: "renamed"
        case .untracked: "untracked"
        case let .unknown(r): r
        }
    }
}

/// "branch": ticket branch vs the base branch; "workdir": uncommitted changes vs HEAD; "pinned": the
/// worktree is gone, so the diff comes from the refs saved while it existed.
public enum ChangesMode: OpenEnum {
    case branch, workdir, pinned
    case unknown(String)

    public static let allKnown: [Self] = [.branch, .workdir, .pinned]
    public var rawValue: String {
        switch self {
        case .branch: "branch"
        case .workdir: "workdir"
        case .pinned: "pinned"
        case let .unknown(r): r
        }
    }
}

public struct ChangedFile: Codable, Sendable, Equatable, Identifiable {
    public var path: String
    public var oldPath: String?
    public var status: ChangedFileStatus
    public var additions: Int
    public var deletions: Int
    public var binary: Bool

    public var id: String { path }

    public init(path: String, oldPath: String? = nil, status: ChangedFileStatus, additions: Int, deletions: Int, binary: Bool = false) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.additions = additions
        self.deletions = deletions
        self.binary = binary
    }
}

public struct Changes: Codable, Sendable, Equatable {
    public var mode: ChangesMode
    /// Base ref name ("main", or "HEAD" in workdir mode); nil when no base branch could be found
    @Nullable public var base: String?
    /// The commit the diff starts from (merge-base in branch mode, HEAD in workdir mode); nil for an empty repo
    @Nullable public var baseSha: String?
    /// HEAD of the workdir (the pinned branch head in pinned mode); nil for an unborn branch
    @Nullable public var head: String?
    /// The ticket's branch, or the workdir's current branch in workdir mode
    @Nullable public var branch: String?
    public var files: [ChangedFile]
    /// Unified diff (git format), cut at a file boundary when truncated
    public var patch: String
    public var truncated: Bool
    public var additions: Int
    public var deletions: Int
    /// Pinned mode only: the commit holding the pinned uncommitted changes, when there were any
    public var worktree: Patch<String>

    public init(
        mode: ChangesMode, base: String?, baseSha: String?, head: String?, branch: String?, files: [ChangedFile], patch: String,
        truncated: Bool = false, additions: Int, deletions: Int, worktree: Patch<String> = .absent
    ) {
        self.mode = mode
        self.base = base
        self.baseSha = baseSha
        self.head = head
        self.branch = branch
        self.files = files
        self.patch = patch
        self.truncated = truncated
        self.additions = additions
        self.deletions = deletions
        self.worktree = worktree
    }

    /// The pinned worktree commit, when there is one.
    public var worktreeSha: String? { worktree.optional }
}

public struct ChangesCommit: Codable, Sendable, Equatable, Identifiable {
    public var sha: String
    public var shortSha: String
    public var subject: String
    public var author: String
    public var email: String
    /// epoch ms
    public var date: Double

    public var id: String { sha }

    public init(sha: String, shortSha: String, subject: String, author: String, email: String, date: Double) {
        self.sha = sha
        self.shortSha = shortSha
        self.subject = subject
        self.author = author
        self.email = email
        self.date = date
    }
}

/// GET /log: the branch's commits since the base (none in workdir mode).
public struct ChangesLog: Codable, Sendable, Equatable {
    public var mode: ChangesMode
    @Nullable public var base: String?
    public var commits: [ChangesCommit]

    public init(mode: ChangesMode, base: String?, commits: [ChangesCommit]) {
        self.mode = mode
        self.base = base
        self.commits = commits
    }
}

/// GET /file: one side of a changed file; nil when that side doesn't exist.
public struct ChangesFileContents: Codable, Sendable, Equatable {
    @Nullable public var contents: String?

    public init(contents: String?) {
        self.contents = contents
    }
}
