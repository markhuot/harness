import Foundation

// ---------------------------------------------------------------------------
// REST API request bodies (responses are the entities, wrapped as { data })
// ---------------------------------------------------------------------------
//
// `field?: T | null` is `Patch<T>`: `.absent` (the default) leaves the key out, `.null` sends an
// explicit null (clear / inherit), `.value` sets it. Per-driver and per-prompt maps are
// `[String: String?]`, where a nil value is sent as null (clears that entry).

public struct CreateProjectBody: Codable, Sendable, Equatable {
    public var path: String
    public var name: String?
    public var key: String?
    public var defaultDriver: Patch<String>
    public var useWorktrees: Bool?
    /// Project.skipAgentReview: new tickets skip their agent review by default. Default false.
    public var skipAgentReview: Bool?
    /// Project.skipHumanReview: new tickets skip their human review by default. Default false.
    public var skipHumanReview: Bool?
    /// Deprecated, from older apps: false means skipHumanReview true. Ignored with skipHumanReview.
    public var requireHumanReview: Bool?
    /// Preset id from PROJECT_COLORS or "#rrggbb"; null or "" → the theme's accent
    public var color: Patch<String>
    /// The project's group (ProjectGroups.normalize); null or "" → none. A name matching an
    /// existing group without case takes that group's spelling.
    public var group: Patch<String>
    /// null → settings.permissionMode
    public var permissionMode: Patch<PermissionMode>
    /// Per-driver default models; PATCH merges per driver, null clears one
    public var defaultModels: [String: String?]?
    /// A valid branch name; null or "" → inherit settings.baseBranch
    public var baseBranch: Patch<String>
    /// The default completion action; must be one the project offers. Default "merge".
    public var completionAction: CompletionAction?

    public init(
        path: String, name: String? = nil, key: String? = nil, defaultDriver: Patch<String> = .absent,
        useWorktrees: Bool? = nil, skipAgentReview: Bool? = nil, skipHumanReview: Bool? = nil, requireHumanReview: Bool? = nil,
        color: Patch<String> = .absent, group: Patch<String> = .absent, permissionMode: Patch<PermissionMode> = .absent,
        defaultModels: [String: String?]? = nil, baseBranch: Patch<String> = .absent,
        completionAction: CompletionAction? = nil
    ) {
        self.path = path
        self.name = name
        self.key = key
        self.defaultDriver = defaultDriver
        self.useWorktrees = useWorktrees
        self.skipAgentReview = skipAgentReview
        self.skipHumanReview = skipHumanReview
        self.requireHumanReview = requireHumanReview
        self.color = color
        self.group = group
        self.permissionMode = permissionMode
        self.defaultModels = defaultModels
        self.baseBranch = baseBranch
        self.completionAction = completionAction
    }
}

/// PATCH /projects/:id: `Partial<CreateProjectBody>`.
public struct UpdateProjectBody: Codable, Sendable, Equatable {
    public var path: String?
    public var name: String?
    public var key: String?
    public var defaultDriver: Patch<String>
    public var useWorktrees: Bool?
    /// Project.skipAgentReview: new tickets skip their agent review by default
    public var skipAgentReview: Bool?
    /// Project.skipHumanReview: new tickets skip their human review by default
    public var skipHumanReview: Bool?
    /// Deprecated, from older apps: false means skipHumanReview true. Ignored with skipHumanReview.
    public var requireHumanReview: Bool?
    /// Preset id from PROJECT_COLORS or "#rrggbb"; null or "" → the theme's accent
    public var color: Patch<String>
    /// The project's group (ProjectGroups.normalize); null or "" → none. A name matching an
    /// existing group without case takes that group's spelling.
    public var group: Patch<String>
    /// null → settings.permissionMode
    public var permissionMode: Patch<PermissionMode>
    /// Per-driver default models; PATCH merges per driver, null clears one
    public var defaultModels: [String: String?]?
    /// A valid branch name; null or "" → inherit settings.baseBranch
    public var baseBranch: Patch<String>
    /// The default completion action; must be one the project offers.
    public var completionAction: CompletionAction?

    public init(
        path: String? = nil, name: String? = nil, key: String? = nil, defaultDriver: Patch<String> = .absent,
        useWorktrees: Bool? = nil, skipAgentReview: Bool? = nil, skipHumanReview: Bool? = nil, requireHumanReview: Bool? = nil,
        color: Patch<String> = .absent, group: Patch<String> = .absent, permissionMode: Patch<PermissionMode> = .absent,
        defaultModels: [String: String?]? = nil, baseBranch: Patch<String> = .absent,
        completionAction: CompletionAction? = nil
    ) {
        self.path = path
        self.name = name
        self.key = key
        self.defaultDriver = defaultDriver
        self.useWorktrees = useWorktrees
        self.skipAgentReview = skipAgentReview
        self.skipHumanReview = skipHumanReview
        self.requireHumanReview = requireHumanReview
        self.color = color
        self.group = group
        self.permissionMode = permissionMode
        self.defaultModels = defaultModels
        self.baseBranch = baseBranch
        self.completionAction = completionAction
    }
}

public struct CreateTicketBody: Codable, Sendable, Equatable {
    public var projectId: String
    /// The ticket's spec: revision 1, and the first run's message. Title is derived from it when
    /// title is omitted.
    public var spec: String
    public var title: String?
    public var kind: TicketKind?
    public var driver: String?
    /// Model for this ticket's runs (null / omitted → defaults)
    public var model: Patch<String>
    /// Permission mode override (null / omitted → project → settings)
    public var permissionMode: Patch<PermissionMode>
    /// Skip planning and start work right away (default true for quick sessions)
    public var start: Bool?
    /// Worktree for this ticket: false → the project checkout (null / omitted → project.useWorktrees)
    public var useWorktree: Patch<Bool>
    /// The branch the ticket's worktree checks out (Ticket.requestedBranch). null / omitted / "" →
    /// harness/<key>. An existing local branch is checked out as is (the ticket blocks if another
    /// worktree has it checked out); a new name is created from the base branch. Needs a worktree:
    /// refused with useWorktree false. Pick names from GET /projects/:id/branches.
    public var branch: Patch<String>
    /// Base branch override (Ticket.baseBranch); null / "" → inherit the project's
    public var baseBranch: Patch<String>
    /// Skip the agent review when the ticket is submitted (Ticket.skipAgentReview). Default: the project's.
    public var skipAgentReview: Bool?
    /// Skip the human review: the ticket lands once its agent review passes (Ticket.skipHumanReview). Default: the project's.
    public var skipHumanReview: Bool?
    public var dependsOn: [String]?
    public var autoStart: Bool?
    public var parentId: Patch<String>
    /// Use this key instead of the next native key. Only for imports and tests: watcher tickets get
    /// native keys and carry the remote ID in externalRef.
    public var key: String?
    public var externalRef: Patch<ExternalRef>
    /// Save it as a draft (Ticket.draft): created in planning with no run, whatever `start` says.
    /// POST /tickets/:key/submit launches it later. The spec may be empty for a draft.
    public var draft: Bool?
    /// Files to attach to the prompt (Ticket.promptAttachments), at most `maxPromptAttachments`: by
    /// `id` (an upload, a registered file) or by `path` (existing now; 400 otherwise). Pastes and
    /// files from another device go through POST /uploads first.
    public var promptAttachments: [AttachmentInput]?

    public init(
        projectId: String, spec: String, title: String? = nil, kind: TicketKind? = nil, driver: String? = nil,
        model: Patch<String> = .absent, permissionMode: Patch<PermissionMode> = .absent, start: Bool? = nil,
        useWorktree: Patch<Bool> = .absent, branch: Patch<String> = .absent, baseBranch: Patch<String> = .absent,
        skipAgentReview: Bool? = nil, skipHumanReview: Bool? = nil, dependsOn: [String]? = nil, autoStart: Bool? = nil,
        parentId: Patch<String> = .absent, key: String? = nil, externalRef: Patch<ExternalRef> = .absent,
        draft: Bool? = nil, promptAttachments: [AttachmentInput]? = nil
    ) {
        self.projectId = projectId
        self.spec = spec
        self.title = title
        self.kind = kind
        self.driver = driver
        self.model = model
        self.permissionMode = permissionMode
        self.start = start
        self.useWorktree = useWorktree
        self.branch = branch
        self.baseBranch = baseBranch
        self.skipAgentReview = skipAgentReview
        self.skipHumanReview = skipHumanReview
        self.dependsOn = dependsOn
        self.autoStart = autoStart
        self.parentId = parentId
        self.key = key
        self.externalRef = externalRef
        self.draft = draft
        self.promptAttachments = promptAttachments
    }
}

public struct UpdateTicketBody: Codable, Sendable, Equatable {
    public var title: String?
    /// A new spec revision, written by the human. Needs baseRevision unless the ticket is a draft.
    public var spec: String?
    /// The spec revision the edit started from (Ticket.specRevision when the editor opened). A spec
    /// that moved on since answers 409 with the current revision in `data` (SpecConflict), so a
    /// human's edit never overwrites an agent's without them seeing it.
    public var baseRevision: Int?
    /// A few words on what the edit changed, kept with the revision (default "Edited by hand")
    public var specNote: String?
    /// manual moves from the board
    public var status: TicketStatus?
    /// Changing the driver clears the model unless `model` is given too
    public var driver: String?
    /// Applies from the next run (claude-code resumes the conversation with the new --model)
    public var model: Patch<String>
    /// Applies from the next tool call / run; null → inherit from the project / settings
    public var permissionMode: Patch<PermissionMode>
    /// Base branch override; null / "" → inherit the project's. Applies from the next run.
    public var baseBranch: Patch<String>
    /// The branch for the ticket's worktree (see CreateTicketBody.branch). Only while the ticket has
    /// no worktree (409 once it has one: its agent re-points it with the update_branch tool).
    public var branch: Patch<String>
    /// Ticket.skipAgentReview. Turning it on while the ticket waits on its agent review skips that
    /// review (a queued review run is dropped); turning it off while the review is "skipped" starts one.
    public var skipAgentReview: Bool?
    /// Ticket.skipHumanReview. Turning it on while the ticket waits on its human review approves it
    /// (the ticket lands once its agent review passes); turning it off while a review it approved
    /// hasn't started landing puts the human review back to pending.
    public var skipHumanReview: Bool?
    public var dependsOn: [String]?
    public var position: Double?
    /// Link the ticket to a remote ID by hand (source "manual"), or null to unlink it
    public var externalRef: Patch<ExternalRefInput>
    /// Drafts only (409 otherwise): what the ticket is, fixed once it launches
    public var kind: TicketKind?
    /// Drafts only (409 otherwise): Ticket.useWorktree, fixed once it launches
    public var useWorktree: Patch<Bool>
    /// Drafts only (409 otherwise): move the draft to another project. It takes that project's next
    /// key; the old key is kept as an alias (like a project rename), so open panes follow it.
    public var projectId: String?
    /// Drafts only (409 otherwise): the whole new list of prompt attachments. New files must exist;
    /// ones the draft already had are kept as they are, even when their file has gone missing.
    public var promptAttachments: [AttachmentInput]?

    public init(
        title: String? = nil, spec: String? = nil, baseRevision: Int? = nil, specNote: String? = nil, status: TicketStatus? = nil, driver: String? = nil,
        model: Patch<String> = .absent, permissionMode: Patch<PermissionMode> = .absent,
        baseBranch: Patch<String> = .absent, branch: Patch<String> = .absent, skipAgentReview: Bool? = nil,
        skipHumanReview: Bool? = nil, dependsOn: [String]? = nil, position: Double? = nil, externalRef: Patch<ExternalRefInput> = .absent,
        kind: TicketKind? = nil, useWorktree: Patch<Bool> = .absent, projectId: String? = nil,
        promptAttachments: [AttachmentInput]? = nil
    ) {
        self.title = title
        self.spec = spec
        self.baseRevision = baseRevision
        self.specNote = specNote
        self.status = status
        self.driver = driver
        self.model = model
        self.permissionMode = permissionMode
        self.baseBranch = baseBranch
        self.branch = branch
        self.skipAgentReview = skipAgentReview
        self.skipHumanReview = skipHumanReview
        self.dependsOn = dependsOn
        self.position = position
        self.externalRef = externalRef
        self.kind = kind
        self.useWorktree = useWorktree
        self.projectId = projectId
        self.promptAttachments = promptAttachments
    }
}

/// POST /tickets/:key/submit: launch a draft, starting work now (start) or planning first.
public struct SubmitTicketBody: Codable, Sendable, Equatable {
    public var start: Bool
    public init(start: Bool) { self.start = start }
}

public struct HumanReviewBody: Codable, Sendable, Equatable {
    public var decision: HumanReviewDecision
    public var notes: String?
    /// With "approve": how the work lands once the ticket is ready (kept on the ticket until then).
    /// Omitted → the ticket's earlier choice, else the project default. Must be one the ticket offers.
    public var action: CompletionAction?
    /// With "approve": instructions for the completion run (required in spirit for custom).
    public var instructions: String?

    public init(decision: HumanReviewDecision, notes: String? = nil, action: CompletionAction? = nil, instructions: String? = nil) {
        self.decision = decision
        self.notes = notes
        self.action = action
        self.instructions = instructions
    }
}

/// POST /tickets/:key/messages
public struct MessageBody: Codable, Sendable, Equatable {
    /// May be empty when the message carries attachments.
    public var text: String
    /// Files sent with the message (at most maxPromptAttachments), like a New session's
    /// promptAttachments: by `id` (a spec image, an upload, a registered file, a file from an
    /// earlier message) or by `path`.
    /// The agent gets their paths, and images inline. Not allowed while a tool approval waits (a
    /// message then answers it as a deny).
    public var attachments: [AttachmentInput]?

    public init(text: String, attachments: [AttachmentInput]? = nil) {
        self.text = text
        self.attachments = attachments
    }
}

/// Re-open a done ticket: back to in progress, with notes for the agent
public struct ReopenBody: Codable, Sendable, Equatable {
    public var notes: String
    public init(notes: String) { self.notes = notes }
}

public struct ApprovalBody: Codable, Sendable, Equatable {
    /// allow_once: this exact call; allow_tool: every future call of this tool on this ticket; deny
    public var decision: ApprovalDecision
    /// Optional note passed to the agent (why denied / what to do instead)
    public var message: String?

    public init(decision: ApprovalDecision, message: String? = nil) {
        self.decision = decision
        self.message = message
    }
}

public struct CompleteBody: Codable, Sendable, Equatable {
    /// How the work lands; omitted → the choice made at approval, else the project default.
    public var action: CompletionAction?
    /// Extra instructions for the completion run, e.g. "merge into main"
    public var instructions: String?
    /// Mark done without running the agent ("Approve and take no action"): on a ticket in review this
    /// also records the human approval.
    public var skipAgent: Bool?

    public init(action: CompletionAction? = nil, instructions: String? = nil, skipAgent: Bool? = nil) {
        self.action = action
        self.instructions = instructions
        self.skipAgent = skipAgent
    }
}

/// POST /watchers and PATCH /watchers/:id bodies: Watcher fields, with `models` as a per-driver
/// patch (merged over the stored map; null clears a driver's entry). POST needs `name` and `command`.
public struct WatcherBody: Codable, Sendable, Equatable {
    public var id: String?
    public var name: String?
    public var command: String?
    public var args: [String]?
    public var prompt: String?
    public var cwd: Patch<String>
    public var env: [String: String]?
    public var mode: WatcherMode?
    public var intervalSec: Int?
    public var enabled: Bool?
    public var driver: Patch<String>
    public var models: [String: String?]?
    public var lastRunAt: Patch<Timestamp>
    public var lastError: Patch<String>
    public var createdAt: Timestamp?
    public var updatedAt: Timestamp?
    public var live: WatcherLive?

    public init(
        id: String? = nil, name: String? = nil, command: String? = nil, args: [String]? = nil, prompt: String? = nil,
        cwd: Patch<String> = .absent, env: [String: String]? = nil, mode: WatcherMode? = nil, intervalSec: Int? = nil,
        enabled: Bool? = nil, driver: Patch<String> = .absent, models: [String: String?]? = nil,
        lastRunAt: Patch<Timestamp> = .absent, lastError: Patch<String> = .absent, createdAt: Timestamp? = nil,
        updatedAt: Timestamp? = nil, live: WatcherLive? = nil
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

/// PATCH /settings: `Partial<Settings>`. Maps merge per key (a nil value clears that entry);
/// `anthropicApiKey: .null` / `claudeOauthToken: .null` remove the stored key / token.
public struct SettingsPatch: Codable, Sendable, Equatable {
    public var defaultDriver: String?
    public var maxConcurrentRuns: Int?
    public var permissionMode: PermissionMode?
    public var classifier: ClassifierBackend?
    public var defaultModels: [String: String?]?
    public var reviewModels: [String: String?]?
    public var watcherDriver: Patch<String>
    public var watcherModels: [String: String?]?
    public var anthropicApiKey: Patch<String>
    /// Long-lived Claude token for the claude-code driver; `.null` (or "") clears it.
    public var claudeOauthToken: Patch<String>
    /// GitHub token for the github-copilot driver; `.null` (or "") clears it.
    public var copilotGithubToken: Patch<String>
    public var baseBranch: String?
    public var listen: ListenSetting?
    public var browserIdleTabMinutes: Int?
    /// Prompt id (`PromptId.rawValue`) → template; nil (null) or "" resets one to the built-in.
    public var prompts: [String: String?]?

    public init(
        defaultDriver: String? = nil, maxConcurrentRuns: Int? = nil, permissionMode: PermissionMode? = nil,
        classifier: ClassifierBackend? = nil, defaultModels: [String: String?]? = nil,
        reviewModels: [String: String?]? = nil, watcherDriver: Patch<String> = .absent,
        watcherModels: [String: String?]? = nil, anthropicApiKey: Patch<String> = .absent,
        claudeOauthToken: Patch<String> = .absent, copilotGithubToken: Patch<String> = .absent, baseBranch: String? = nil, listen: ListenSetting? = nil, browserIdleTabMinutes: Int? = nil,
        prompts: [String: String?]? = nil
    ) {
        self.defaultDriver = defaultDriver
        self.maxConcurrentRuns = maxConcurrentRuns
        self.permissionMode = permissionMode
        self.classifier = classifier
        self.defaultModels = defaultModels
        self.reviewModels = reviewModels
        self.watcherDriver = watcherDriver
        self.watcherModels = watcherModels
        self.anthropicApiKey = anthropicApiKey
        self.claudeOauthToken = claudeOauthToken
        self.copilotGithubToken = copilotGithubToken
        self.baseBranch = baseBranch
        self.listen = listen
        self.browserIdleTabMinutes = browserIdleTabMinutes
        self.prompts = prompts
    }
}

/// POST /watchers/inject: feed output directly, as if a watcher named `source` printed `text`
/// (objects are sent as JSON text). `prompt` plays the watcher's prompt.
public struct InjectOutputBody: Codable, Sendable, Equatable {
    public var source: String
    public var text: JSONValue
    public var prompt: String?

    public init(source: String, text: JSONValue, prompt: String? = nil) {
        self.source = source
        self.text = text
        self.prompt = prompt
    }
}

/// POST /browser/:sessionId/navigate. `tabId`: the tab to load it in (nil: the lowest open one).
public struct NavigateBody: Codable, Sendable, Equatable {
    public var url: String
    public var tabId: Int?
    public init(url: String, tabId: Int? = nil) {
        self.url = url
        self.tabId = tabId
    }
}

// ---------------------------------------------------------------------------
// Response envelopes and small inline response shapes
// ---------------------------------------------------------------------------

/// Every successful response: `{ data }`.
public struct ApiOk<T> {
    public var data: T
    public init(data: T) { self.data = data }
}

extension ApiOk: Sendable where T: Sendable {}
extension ApiOk: Equatable where T: Equatable {}
extension ApiOk: Decodable where T: Decodable {}
extension ApiOk: Encodable where T: Encodable {}

/// Every failed response: `{ error }` (some add a `data`, e.g. RemoteKeyMatches on a 404).
public struct ApiError: Codable, Sendable, Equatable {
    public var error: String
    public init(error: String) { self.error = error }
}

/// `{ ok: true }` (deletes, restarts, watcher runs).
public struct OkResponse: Codable, Sendable, Equatable {
    public var ok: Bool
    public init(ok: Bool = true) { self.ok = ok }
}

/// POST /drivers/:id/login
public struct DriverLoginResponse: Codable, Sendable, Equatable {
    @Nullable public var url: String?
    public var message: String

    public init(url: String? = nil, message: String) {
        self.url = url
        self.message = message
    }
}

/// POST /token/rotate
public struct RotateTokenResponse: Codable, Sendable, Equatable {
    public var token: String
    public init(token: String) { self.token = token }
}
