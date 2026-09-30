import Foundation

public struct Project: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    /// Upper-case key prefix used for ticket ids, e.g. "NYTIMES" → NYTIMES-1
    public var key: String
    public var name: String
    /// Absolute path of the working directory agents start in
    public var path: String
    /// Next sequence number handed out for a native ticket key
    public var nextSeq: Int
    /// Default driver id for new tickets in this project (falls back to settings.defaultDriver)
    @Nullable public var defaultDriver: String?
    /// Default model per driver id for new runs of this project's tickets (overrides
    /// settings.defaultModels; a ticket's own model overrides this). Absent → settings default.
    public var defaultModels: [String: String]
    /// When the project path is a git repo, give each ticket its own worktree + branch
    public var useWorktrees: Bool
    /// Whether the project path is inside a git checkout (checked each time the project is read).
    /// Clients hide worktree choices when it's false. Optional only so older payloads type-check.
    public var isGit: Bool?
    /// When false, the human review step is skipped (agent review alone gates completion)
    public var requireHumanReview: Bool
    /// When true, a top-level ticket starts its complete run (merge + clean up) as soon as both
    /// reviews approve, instead of waiting for a human to press Complete. Conductor children are
    /// left to their conductor.
    public var autoComplete: Bool
    /// Permission mode for this project's tickets (null → settings.permissionMode)
    @Nullable public var permissionMode: PermissionMode?
    /// Branch this project's tickets merge into when they complete, and new ticket branches start
    /// from (DESIGN.md "Branches"). null → settings.baseBranch. Resolve with `resolveBaseBranch`.
    /// The service always sends it; optional only so older payloads type-check.
    public var baseBranch: Patch<String>
    /// What approving one of this project's tickets does by default (DESIGN.md "Completion"): the
    /// choice preselected on the Approve button, and the action used when nobody picks one (no human
    /// review, a conductor completing a child, auto-complete). When the project stops offering it
    /// (see `completionActions`), the effective default falls back to merge, then custom; resolve with
    /// `completionOptions`. Optional only so older payloads type-check.
    public var completionAction: CompletionAction?
    /// The completion actions this project offers, worked out on each read (never stored): custom
    /// only outside git, merge and custom in a git repo, plus pr when `pullRequestHost` is set.
    /// Optional only so older payloads type-check.
    public var completionActions: [CompletionAction]?
    /// The host a pull request would open on, e.g. "github.com" or an Enterprise host: set when `gh`
    /// is installed, the repo has a remote, and gh is logged into that remote's host. null otherwise
    /// (no pr action). Worked out on each read. Optional only so older payloads type-check.
    public var pullRequestHost: Patch<String>
    /// Color of the project's key badge: a preset id from PROJECT_COLORS ("blue") or a custom
    /// "#rrggbb". null → the theme's accent.
    @Nullable public var color: String?
    public var createdAt: Timestamp
    public var updatedAt: Timestamp

    public init(
        id: String, key: String, name: String, path: String, nextSeq: Int, defaultDriver: String? = nil,
        defaultModels: [String: String] = [:], useWorktrees: Bool, isGit: Bool? = nil, requireHumanReview: Bool,
        autoComplete: Bool, permissionMode: PermissionMode? = nil, baseBranch: Patch<String> = .absent,
        completionAction: CompletionAction? = nil, completionActions: [CompletionAction]? = nil,
        pullRequestHost: Patch<String> = .absent, color: String? = nil, createdAt: Timestamp, updatedAt: Timestamp
    ) {
        self.id = id
        self.key = key
        self.name = name
        self.path = path
        self.nextSeq = nextSeq
        self.defaultDriver = defaultDriver
        self.defaultModels = defaultModels
        self.useWorktrees = useWorktrees
        self.isGit = isGit
        self.requireHumanReview = requireHumanReview
        self.autoComplete = autoComplete
        self.permissionMode = permissionMode
        self.baseBranch = baseBranch
        self.completionAction = completionAction
        self.completionActions = completionActions
        self.pullRequestHost = pullRequestHost
        self.color = color
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
