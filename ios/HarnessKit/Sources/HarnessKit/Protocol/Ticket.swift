import Foundation

public struct Ticket: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    /// Jira-style key: native (NYTIMES-3) or mirrored from an external system (FOO-123)
    public var key: String
    public var projectId: String
    public var kind: TicketKind
    public var title: String
    /// The spec (DESIGN.md "Spec revisions and attachments"): a living markdown document with the
    /// goal, plan, status and open questions. Agents keep it current with edit_spec / update_spec;
    /// every write is a revision. This is the current revision's body.
    public var spec: String
    /// The current spec revision (1 for a new ticket). Optional so older fixtures decode.
    public var specRevision: Int?
    /// The revision that was current when the human pressed Start (planning → work): the approved
    /// baseline the agent review diffs against. null until the ticket first starts.
    public var specBaselineRevision: Patch<Int>
    public var status: TicketStatus
    /// The session holding this ticket's transcript
    public var sessionId: String
    public var driver: String
    /// Conductor that owns this ticket, if any
    @Nullable public var parentId: String?
    /// How many tickets have this one as their parent. Any ticket with children acts as a conductor
    /// (see `isConductor`), whatever its kind. Optional only so older services and fixtures type-check.
    public var childCount: Int?
    /// Keys of tickets that must be done before this one can start
    public var dependsOn: [String]
    /// Start automatically once every dependency is done (used by conductors)
    public var autoStart: Bool
    public var agentReview: ReviewState
    public var humanReview: ReviewState
    /// The remote item this ticket is linked to (a Jira issue, a PR), from a watcher's triage or set
    /// by hand. Its `key` is the remote ID the board shows in place of `key` (`displayKey`). Many
    /// tickets can link the same remote ID; `key` stays the ticket's only identity (DESIGN.md
    /// "Remote IDs").
    @Nullable public var externalRef: ExternalRef?
    /// Directory the agent runs in (project path or a worktree)
    @Nullable public var workdir: String?
    /// The git branch checked out in the ticket's worktree, set once the worktree exists. The
    /// invariant: branch set ⇔ the ticket works in a git worktree of its own at `workdir` (a harness
    /// worktree or, after `update_branch`, another worktree that has the branch checked out). null
    /// while the ticket hasn't started, or when it runs in the project checkout itself.
    /// The branch a ticket will use or uses: `plannedBranch(ticket)` (DESIGN.md "Branches").
    @Nullable public var branch: String?
    /// The branch chosen for the ticket (CreateTicketBody.branch, update_branch). When work starts
    /// the worktree checks it out: an existing local branch as is, a new name created from the base
    /// branch. null → harness/<key> (`harnessBranch`). Kept after the worktree exists, so a re-opened
    /// ticket whose worktree was removed gets the same branch back. Optional so older payloads type-check.
    public var requestedBranch: Patch<String>
    /// Base branch override: what this ticket's work merges into when it completes (and where a new
    /// branch starts). null → project → settings; resolve with `resolveBaseBranch`. Optional so
    /// older payloads type-check.
    public var baseBranch: Patch<String>
    /// Per-ticket worktree choice, applied when work starts: true → its own worktree, false → the
    /// project checkout, null → the project's useWorktrees. Optional only so older payloads type-check.
    public var useWorktree: Patch<Bool>
    /// Submitting skips the agent review: agentReview becomes "skipped" and the ticket waits only on
    /// the human (or its conductor). Set when the ticket is created, from the ticket card, or by the
    /// ticket's own agent (`submit_for_review` skip_agent_review). Optional so older payloads type-check.
    public var skipAgentReview: Bool?
    /// Submitting counts the human review as approved: the ticket lands as soon as its agent review
    /// passes, or right away when that's skipped too. Set when the ticket is created, from the ticket
    /// card, or by an agent (`submit_for_review` / `create_ticket` / `update_ticket`
    /// skip_human_review). Optional so older payloads type-check.
    public var skipHumanReview: Bool?
    /// The completion action picked when the ticket was approved (or completed), kept until the
    /// completion runs: a human approval can come before the agent review finishes. null → the
    /// project's default. Optional so older payloads type-check.
    public var completionAction: Patch<CompletionAction>
    /// The approver's instructions for the completion run, kept with `completionAction`.
    public var completionInstructions: Patch<String>
    /// The pull request a "pr" completion opened (the agent records it with record_pull_request).
    /// Later approvals of the ticket default to "pr", so they update the same pull request.
    public var pullRequestUrl: Patch<String>
    /// Whether the ticket's worktree has anything to land: uncommitted changes, or commits its base
    /// branch doesn't have. The service checks with git when the ticket moves to review and when it's
    /// opened. false drops "merge" and "pr" from its completion choices (`Completion.completionOptions`);
    /// null (not checked, no worktree, or git couldn't say) changes nothing. Optional so older payloads
    /// type-check.
    public var hasChanges: Patch<Bool>
    /// A draft (DESIGN.md "Drafts"): a New session saved before it was launched. It stays in planning
    /// and never runs or reaches agents until POST /tickets/:key/submit clears the flag. While it's set,
    /// `kind`, `useWorktree` and `projectId` can still change (UpdateTicketBody). Optional so fixtures
    /// type-check; the service always sends it.
    public var draft: Bool?
    /// Files the human attached to the New session (DESIGN.md "Prompt attachments"): referenced where
    /// they are on the service's machine, never copied. The first run gets their paths and the images
    /// inline. One can go missing later (moved or deleted); GET /tickets/:key/prompt-attachments/:index
    /// answers 404 for it then. Optional so older payloads decode; the service always sends it.
    public var promptAttachments: [PromptAttachment]?
    /// The human's numbered notes on images among `promptAttachments` (DESIGN.md "Annotations"),
    /// each indexing that list. They go with the first message: its run's prompt lists them.
    /// Optional so older payloads decode.
    public var promptAnnotations: [MessageAnnotation]?
    /// Why the ticket is blocked (question for the human), when status = blocked
    @Nullable public var blockedReason: String?
    /// True while any agent run for this ticket is queued or running
    public var busy: Bool
    /// A tool-permission request waiting on a human (claude-code driver). Ticket is blocked meanwhile.
    @Nullable public var pendingApproval: PendingApproval?
    /// Tools the human has allowed for every future call on this ticket ("Bash", "WebFetch", ...)
    public var allowedTools: [String]
    /// Permission mode override for this ticket (null → project → settings)
    @Nullable public var permissionMode: PermissionMode?
    /// Model for this ticket's runs (driver-specific id). null → project / settings / driver default.
    @Nullable public var model: String?
    /// Sort order within a column
    public var position: Double
    /// When the ticket last entered done (ms). Set on the move into done, cleared (null) when it
    /// leaves. The service always sends it; it's optional here only so older fixtures and payloads
    /// still type-check. The Done column sorts by this, newest first (fall back to updatedAt).
    public var completedAt: Patch<Timestamp>
    public var createdAt: Timestamp
    public var updatedAt: Timestamp

    public init(
        id: String, key: String, projectId: String, kind: TicketKind = .task, title: String, spec: String, specRevision: Int? = nil,
        specBaselineRevision: Patch<Int> = .absent,
        status: TicketStatus, sessionId: String, driver: String, parentId: String? = nil, childCount: Int? = nil,
        dependsOn: [String] = [], autoStart: Bool = false, agentReview: ReviewState = .pending,
        humanReview: ReviewState = .pending, externalRef: ExternalRef? = nil, workdir: String? = nil,
        branch: String? = nil, requestedBranch: Patch<String> = .absent, baseBranch: Patch<String> = .absent,
        useWorktree: Patch<Bool> = .absent, skipAgentReview: Bool? = nil, skipHumanReview: Bool? = nil,
        completionAction: Patch<CompletionAction> = .absent, completionInstructions: Patch<String> = .absent,
        pullRequestUrl: Patch<String> = .absent, hasChanges: Patch<Bool> = .absent, draft: Bool? = nil, promptAttachments: [PromptAttachment]? = nil, promptAnnotations: [MessageAnnotation]? = nil, blockedReason: String? = nil, busy: Bool = false,
        pendingApproval: PendingApproval? = nil, allowedTools: [String] = [], permissionMode: PermissionMode? = nil,
        model: String? = nil, position: Double = 0, completedAt: Patch<Timestamp> = .absent,
        createdAt: Timestamp, updatedAt: Timestamp
    ) {
        self.id = id
        self.key = key
        self.projectId = projectId
        self.kind = kind
        self.title = title
        self.spec = spec
        self.specRevision = specRevision
        self.specBaselineRevision = specBaselineRevision
        self.status = status
        self.sessionId = sessionId
        self.driver = driver
        self.parentId = parentId
        self.childCount = childCount
        self.dependsOn = dependsOn
        self.autoStart = autoStart
        self.agentReview = agentReview
        self.humanReview = humanReview
        self.externalRef = externalRef
        self.workdir = workdir
        self.branch = branch
        self.requestedBranch = requestedBranch
        self.baseBranch = baseBranch
        self.useWorktree = useWorktree
        self.skipAgentReview = skipAgentReview
        self.skipHumanReview = skipHumanReview
        self.completionAction = completionAction
        self.completionInstructions = completionInstructions
        self.pullRequestUrl = pullRequestUrl
        self.hasChanges = hasChanges
        self.draft = draft
        self.promptAttachments = promptAttachments
        self.promptAnnotations = promptAnnotations
        self.blockedReason = blockedReason
        self.busy = busy
        self.pendingApproval = pendingApproval
        self.allowedTools = allowedTools
        self.permissionMode = permissionMode
        self.model = model
        self.position = position
        self.completedAt = completedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// `HarnessProtocol.isConductor(kind:childCount:)` for this ticket.
    public var isConductor: Bool { HarnessProtocol.isConductor(kind: kind, childCount: childCount) }
}

/// One page of tickets from GET /tickets/page or GET /tickets/search. `nextCursor` is opaque:
/// pass it back as `cursor` for the next page; null means this was the last page. `total` counts
/// every ticket matching the filter (not just this page).
public struct TicketPage: Codable, Sendable, Equatable {
    public var tickets: [Ticket]
    @Nullable public var nextCursor: String?
    public var total: Int

    public init(tickets: [Ticket], nextCursor: String?, total: Int) {
        self.tickets = tickets
        self.nextCursor = nextCursor
        self.total = total
    }
}

public struct PendingApproval: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var runId: String
    /// Tool the agent wants to use, e.g. "Bash"
    public var toolName: String
    /// The tool input, e.g. { command: "npm install" }
    public var input: JSONValue
    public var requestedAt: Timestamp
    /// Why a human is being asked (e.g. the classifier's judgement)
    public var reason: String?
    /// What sent it to the human: the auto-mode classifier or a static policy (ask mode, ...)
    public var source: PermissionSource?
    /// One-line description of the call for the card and the blocked reason (harness config tools)
    public var summary: String?
    /// Only "allow once" or "deny" may answer it: harness config tools (watchers, settings,
    /// deletes) are never allowed for the rest of a ticket.
    public var onceOnly: Bool?

    public init(
        id: String, runId: String, toolName: String, input: JSONValue, requestedAt: Timestamp, reason: String? = nil,
        source: PermissionSource? = nil, summary: String? = nil, onceOnly: Bool? = nil
    ) {
        self.id = id
        self.runId = runId
        self.toolName = toolName
        self.input = input
        self.requestedAt = requestedAt
        self.reason = reason
        self.source = source
        self.summary = summary
        self.onceOnly = onceOnly
    }
}

public struct ExternalRef: Codable, Sendable, Equatable {
    /// watcher name, e.g. "jira", or "manual" for a link set by hand
    public var source: String
    /// the remote ID, e.g. FOO-123
    public var key: String
    @Nullable public var url: String?
    /// the original item emitted by the watcher (null for a manual link)
    public var raw: JSONValue

    public init(source: String, key: String, url: String? = nil, raw: JSONValue = .null) {
        self.source = source
        self.key = key
        self.url = url
        self.raw = raw
    }

    enum CodingKeys: String, CodingKey { case source, key, url, raw }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decode(String.self, forKey: .source)
        key = try c.decode(String.self, forKey: .key)
        _url = try c.decode(Nullable<String>.self, forKey: .url)
        // `unknown`: a missing key (JSON.stringify drops undefined) reads as null.
        raw = try c.decodeIfPresent(JSONValue.self, forKey: .raw) ?? .null
    }
}

/// A ticket that carries a remote ID (TicketDetail.relatedTickets): another ticket linked to the
/// same remote item, or the tickets a remote ID points to when no local key matches.
public struct RelatedTicket: Codable, Sendable, Equatable {
    public var key: String
    public var title: String
    public var status: TicketStatus
    public var projectId: String
    /// The remote ID it carries
    public var externalKey: String

    public init(key: String, title: String, status: TicketStatus, projectId: String, externalKey: String) {
        self.key = key
        self.title = title
        self.status = status
        self.projectId = projectId
        self.externalKey = externalKey
    }
}

/// A remote ID set by hand (UpdateTicketBody.externalRef). The key is upper-cased and must look
/// like FOO-123; the link's source is "manual".
public struct ExternalRefInput: Codable, Sendable, Equatable {
    public var key: String
    public var url: Patch<String>

    public init(key: String, url: Patch<String> = .absent) {
        self.key = key
        self.url = url
    }
}

/// One permission decision, logged on the transcript as a status entry (content.permission).
public struct PermissionDecisionLog: Codable, Sendable, Equatable {
    /// Tool as the driver names it: "bash", "write_file", "Bash", ...
    public var tool: String
    /// One-line summary of the input (command / path)
    public var summary: String
    /// allow: ran without asking · ask: sent to a human · deny: refused (the agent sees the reason)
    public var decision: PermissionDecision
    public var reason: String
    /// classifier: a model judged it · policy: a static rule (allowlist, mode, hard-deny, grant)
    public var source: PermissionSource
    /// Classifier backend ("claude-cli", "anthropic-api", "claude-code" for the CLI's own auto mode)
    public var backend: String?
    public var latencyMs: Double?
    public var mode: PermissionMode

    public init(
        tool: String, summary: String, decision: PermissionDecision, reason: String, source: PermissionSource,
        backend: String? = nil, latencyMs: Double? = nil, mode: PermissionMode
    ) {
        self.tool = tool
        self.summary = summary
        self.decision = decision
        self.reason = reason
        self.source = source
        self.backend = backend
        self.latencyMs = latencyMs
        self.mode = mode
    }
}

public struct TicketDetail: Codable, Sendable, Equatable {
    /// Set when the requested key is an old key of this ticket (from before a project rename):
    /// the key that was asked for. `ticket.key` is the current key; clients should show and
    /// link that one instead (e.g. replace the URL).
    public var resolvedFrom: String?
    public var ticket: Ticket
    public var session: Session
    /// The ticket's Activity, oldest first
    public var activity: [ActivityEntry]
    public var runs: [Run]
    public var dependents: [String]
    public var children: [Ticket]
    /// The conductor this ticket belongs to (when parentId is set), so clients can show the
    /// "Part of …" breadcrumb even when the parent isn't loaded (e.g. a done conductor off-page).
    public var parent: Patch<Ticket>
    /// Sub-agents started in the ticket's session, oldest first (absent from older services)
    public var subagents: [Subagent]?
    /// Other tickets carrying a remote ID equal to the requested key or to this ticket's own remote
    /// ID, newest first. Absent from older services.
    public var relatedTickets: [RelatedTicket]?

    public init(
        resolvedFrom: String? = nil, ticket: Ticket, session: Session, activity: [ActivityEntry] = [], runs: [Run] = [],
        dependents: [String] = [], children: [Ticket] = [], parent: Patch<Ticket> = .absent,
        subagents: [Subagent]? = nil, relatedTickets: [RelatedTicket]? = nil
    ) {
        self.resolvedFrom = resolvedFrom
        self.ticket = ticket
        self.session = session
        self.activity = activity
        self.runs = runs
        self.dependents = dependents
        self.children = children
        self.parent = parent
        self.subagents = subagents
        self.relatedTickets = relatedTickets
    }
}

/// The `data` of GET /tickets/:key's 404 when no local key matches but tickets carry the requested
/// key as their remote ID: a remote ID never opens a ticket, it points to the local ones.
public struct RemoteKeyMatches: Codable, Sendable, Equatable {
    public var requested: String
    public var relatedTickets: [RelatedTicket]

    public init(requested: String, relatedTickets: [RelatedTicket]) {
        self.requested = requested
        self.relatedTickets = relatedTickets
    }
}
