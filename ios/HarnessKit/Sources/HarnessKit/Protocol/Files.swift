import Foundation

/// One local branch of a project's repository, from GET /projects/:id/branches?q=&limit=
/// (ApiClient.projectBranches), for the new-session branch picker. Most recent commit first; `q`
/// filters case-insensitively (substring matches first, then names containing q's characters in
/// order); `limit` defaults to 50 (max 200). A project that isn't a git repo gives [].
public struct BranchInfo: Codable, Sendable, Equatable {
    /// Short name, e.g. "main", "medl-1223-ai-app", "harness/web-3"
    public var name: String
    /// Committer date of the branch tip (ms)
    public var lastCommitAt: Timestamp
    /// Path of a worktree that has the branch checked out (the main checkout included), else null.
    /// A new ticket can't take a branch that is checked out elsewhere: it would block.
    @Nullable public var checkedOutAt: String?

    public init(name: String, lastCommitAt: Timestamp, checkedOutAt: String? = nil) {
        self.name = name
        self.lastCommitAt = lastCommitAt
        self.checkedOutAt = checkedOutAt
    }
}

/// Where a file stands in git (GET /…/file). All false when the root isn't in a repository.
/// `dirty` is any difference from HEAD (staged, unstaged, or untracked); an ignored file is
/// neither tracked nor untracked, and never dirty.
public struct FileGitState: Codable, Sendable, Equatable {
    public var repo: Bool
    public var tracked: Bool
    public var dirty: Bool
    public var untracked: Bool
    public var ignored: Bool

    public init(repo: Bool, tracked: Bool, dirty: Bool, untracked: Bool, ignored: Bool) {
        self.repo = repo
        self.tracked = tracked
        self.dirty = dirty
        self.untracked = untracked
        self.ignored = ignored
    }
}

/// A project or ticket file for the file viewer (GET /projects/:id/file, /tickets/:key/file), read
/// from disk, gitignored files included. `contents` is null for binary files (a NUL in the first
/// 8 KB) and files over 2 MiB (`tooLarge`). `truncated` means `contents` is only the start of the
/// file: it grew past the cap while being read.
public struct FileView: Codable, Sendable, Equatable {
    /// Relative to `root`, "/"-separated
    public var path: String
    /// The folder the path is resolved in: the ticket's worktree, else its session's cwd, else the project folder
    public var root: String
    public var size: Int
    @Nullable public var contents: String?
    public var binary: Bool
    public var truncated: Bool
    public var tooLarge: Bool
    public var git: FileGitState

    public init(
        path: String, root: String, size: Int, contents: String? = nil, binary: Bool = false, truncated: Bool = false,
        tooLarge: Bool = false, git: FileGitState
    ) {
        self.path = path
        self.root = root
        self.size = size
        self.contents = contents
        self.binary = binary
        self.truncated = truncated
        self.tooLarge = tooLarge
        self.git = git
    }
}

/// One file's uncommitted changes (GET /…/file/diff): the working tree against HEAD, staged and
/// unstaged together; an untracked file shows as added. `patch` is a unified git diff ("" when the
/// file is clean or ignored). Either side's contents is null when it doesn't exist there, is binary,
/// or is over 2 MiB. A root outside any git repository is a 409.
public struct FileDiff: Codable, Sendable, Equatable {
    public var path: String
    public var patch: String
    @Nullable public var oldContents: String?
    @Nullable public var newContents: String?
    /// The patch is over 4 MiB, so `patch` is "" even though the file changed
    public var tooLarge: Bool

    public init(path: String, patch: String, oldContents: String? = nil, newContents: String? = nil, tooLarge: Bool = false) {
        self.path = path
        self.patch = patch
        self.oldContents = oldContents
        self.newContents = newContents
        self.tooLarge = tooLarge
    }
}

/// Options for the /files search. `ignored` also indexes node_modules; `kind` keeps one kind.
public struct FileSearchOptions: Codable, Sendable, Equatable {
    public var limit: Int?
    public var ignored: Bool?
    public var kind: FileKind?

    public init(limit: Int? = nil, ignored: Bool? = nil, kind: FileKind? = nil) {
        self.limit = limit
        self.ignored = ignored
        self.kind = kind
    }
}

/// A /files search hit (shared/src/mentions.ts).
public struct FileMatch: Codable, Sendable, Equatable {
    public var path: String
    public var kind: FileKind
    /// Git ignores it (or it's in node_modules). Only the file browser's search (`ignored=1`) says
    /// so. The TS type is `true` (never false): absent means not ignored.
    public var ignored: Bool?

    public init(path: String, kind: FileKind, ignored: Bool? = nil) {
        self.path = path
        self.kind = kind
        self.ignored = ignored
    }
}

/// A slash command a ticket's driver offers (shared/src/commands.ts; GET /…/commands).
public struct CommandMatch: Codable, Sendable, Equatable {
    /// Typed after the slash: "code-walk", "vercel:deploy".
    public var name: String
    public var description: String
    /// What the command takes after its name ("[pr number]"), when it says.
    public var argumentHint: String?

    public init(name: String, description: String, argumentHint: String? = nil) {
        self.name = name
        self.description = description
        self.argumentHint = argumentHint
    }
}
