import Foundation

// String unions from protocol.ts (and mentions.ts), as open enums (see OpenEnum.swift). Named
// TS types keep their names; anonymous inline unions get a name after the field they type.

/// How much an agent may do without asking (DESIGN.md "Permissions"):
/// - "auto":      a classifier judges each unapproved action (Claude Code's auto mode for
///                claude-code; the harness PermissionGate + classifier for native-tool drivers)
/// - "ask":       edits inside the workdir are allowed, everything else asks a human
/// - "read_only": reads only; writes and non-read-only commands are denied
public enum PermissionMode: OpenEnum {
    case auto, ask, readOnly
    case unknown(String)
    /// PERMISSION_MODES
    public static let allKnown: [Self] = [.auto, .ask, .readOnly]
    public var rawValue: String {
        switch self {
        case .auto: "auto"
        case .ask: "ask"
        case .readOnly: "read_only"
        case let .unknown(r): r
        }
    }
}

/// Who judges actions in auto mode for native-tool drivers ("off": ask a human instead).
public enum ClassifierBackend: OpenEnum {
    case claudeCli, anthropicApi, off
    case unknown(String)
    /// CLASSIFIER_BACKENDS
    public static let allKnown: [Self] = [.claudeCli, .anthropicApi, .off]
    public var rawValue: String {
        switch self {
        case .claudeCli: "claude-cli"
        case .anthropicApi: "anthropic-api"
        case .off: "off"
        case let .unknown(r): r
        }
    }
}

/// PermissionDecisionLog.decision. allow: ran without asking · ask: sent to a human · deny:
/// refused (the agent sees the reason)
public enum PermissionDecision: OpenEnum {
    case allow, ask, deny
    case unknown(String)
    public static let allKnown: [Self] = [.allow, .ask, .deny]
    public var rawValue: String {
        switch self {
        case .allow: "allow"
        case .ask: "ask"
        case .deny: "deny"
        case let .unknown(r): r
        }
    }
}

/// PermissionDecisionLog.source and PendingApproval.source. classifier: a model judged it ·
/// policy: a static rule (allowlist, mode, hard-deny, grant)
public enum PermissionSource: OpenEnum {
    case classifier, policy
    case unknown(String)
    public static let allKnown: [Self] = [.classifier, .policy]
    public var rawValue: String {
        switch self {
        case .classifier: "classifier"
        case .policy: "policy"
        case let .unknown(r): r
        }
    }
}

public enum TicketStatus: OpenEnum {
    case planning, inProgress, blocked, review, done
    case unknown(String)
    /// TICKET_STATUSES
    public static let allKnown: [Self] = [.planning, .inProgress, .blocked, .review, .done]
    public var rawValue: String {
        switch self {
        case .planning: "planning"
        case .inProgress: "in_progress"
        case .blocked: "blocked"
        case .review: "review"
        case .done: "done"
        case let .unknown(r): r
        }
    }
}

/// "skipped" is only ever an agent review: the ticket has `skipAgentReview`, so submitting didn't
/// start a review run (DESIGN.md "Skipping the agent review"). It counts as passed (`reviewPassed`).
public enum ReviewState: OpenEnum {
    case pending, approved, changesRequested, skipped
    case unknown(String)
    public static let allKnown: [Self] = [.pending, .approved, .changesRequested, .skipped]
    public var rawValue: String {
        switch self {
        case .pending: "pending"
        case .approved: "approved"
        case .changesRequested: "changes_requested"
        case .skipped: "skipped"
        case let .unknown(r): r
        }
    }
}

public enum TicketKind: OpenEnum {
    case task, conductor
    case unknown(String)
    public static let allKnown: [Self] = [.task, .conductor]
    public var rawValue: String {
        switch self {
        case .task: "task"
        case .conductor: "conductor"
        case let .unknown(r): r
        }
    }
}

/// How an approved ticket's work lands (DESIGN.md "Completion"), each with its own completion
/// prompts: "merge" merges the branch into its base branch locally, "pr" pushes it and opens a
/// GitHub pull request with gh, "custom" follows the approver's own instructions.
public enum CompletionAction: OpenEnum {
    case merge, pr, cleanup, custom
    case unknown(String)
    /// COMPLETION_ACTIONS
    public static let allKnown: [Self] = [.merge, .pr, .cleanup, .custom]
    public var rawValue: String {
        switch self {
        case .merge: "merge"
        case .pr: "pr"
        case .cleanup: "cleanup"
        case .custom: "custom"
        case let .unknown(r): r
        }
    }
}

public enum SessionKind: OpenEnum {
    case ticket, triage
    case unknown(String)
    public static let allKnown: [Self] = [.ticket, .triage]
    public var rawValue: String {
        switch self {
        case .ticket: "ticket"
        case .triage: "triage"
        case let .unknown(r): r
        }
    }
}

public enum TriageStatus: OpenEnum {
    case triaging, dispatched, declined, failed
    case unknown(String)
    public static let allKnown: [Self] = [.triaging, .dispatched, .declined, .failed]
    public var rawValue: String {
        switch self {
        case .triaging: "triaging"
        case .dispatched: "dispatched"
        case .declined: "declined"
        case .failed: "failed"
        case let .unknown(r): r
        }
    }
}

/// chat: a human message to a blocked, review or done ticket, answered by its agent with the work
/// tools (the agent moves the ticket itself).
public enum RunKind: OpenEnum {
    case plan, work, review, complete, conductor, triage, chat
    case unknown(String)
    public static let allKnown: [Self] = [.plan, .work, .review, .complete, .conductor, .triage, .chat]
    public var rawValue: String {
        switch self {
        case .plan: "plan"
        case .work: "work"
        case .review: "review"
        case .complete: "complete"
        case .conductor: "conductor"
        case .triage: "triage"
        case .chat: "chat"
        case let .unknown(r): r
        }
    }
}

public enum RunStatus: OpenEnum {
    case queued, running, succeeded, failed, cancelled
    case unknown(String)
    public static let allKnown: [Self] = [.queued, .running, .succeeded, .failed, .cancelled]
    public var rawValue: String {
        switch self {
        case .queued: "queued"
        case .running: "running"
        case .succeeded: "succeeded"
        case .failed: "failed"
        case .cancelled: "cancelled"
        case let .unknown(r): r
        }
    }
}

public enum TranscriptRole: OpenEnum {
    case user, assistant, tool, system
    case unknown(String)
    public static let allKnown: [Self] = [.user, .assistant, .tool, .system]
    public var rawValue: String {
        switch self {
        case .user: "user"
        case .assistant: "assistant"
        case .tool: "tool"
        case .system: "system"
        case let .unknown(r): r
        }
    }
}

/// stopped: its run ended (cancelled, failed, or the driver never reported an outcome)
public enum SubagentStatus: OpenEnum {
    case running, succeeded, failed, stopped
    case unknown(String)
    public static let allKnown: [Self] = [.running, .succeeded, .failed, .stopped]
    public var rawValue: String {
        switch self {
        case .running: "running"
        case .succeeded: "succeeded"
        case .failed: "failed"
        case .stopped: "stopped"
        case let .unknown(r): r
        }
    }
}

/// agent: a sub-agent; bash / monitor: a background task (a Bash command, a Monitor)
public enum SubagentKind: OpenEnum {
    case agent, bash, monitor
    case unknown(String)
    public static let allKnown: [Self] = [.agent, .bash, .monitor]
    public var rawValue: String {
        switch self {
        case .agent: "agent"
        case .bash: "bash"
        case .monitor: "monitor"
        case let .unknown(r): r
        }
    }
}

public enum ActivityAuthor: OpenEnum {
    case agent, human, system
    case unknown(String)
    public static let allKnown: [Self] = [.agent, .human, .system]
    public var rawValue: String {
        switch self {
        case .agent: "agent"
        case .human: "human"
        case .system: "system"
        case let .unknown(r): r
        }
    }
}

/// What an Activity entry records (DESIGN.md "Activity"), ACTIVITY_KINDS in protocol.ts:
/// - note: an agent's short progress note (post_note)
/// - submitted: the work went to review (the submit note)
/// - blocked: the agent (or a failure) asked the human something; meta.question
/// - unblocked: the agent picked a blocked ticket back up; meta.note when it gave one
/// - reviewApproved / changesRequested: an agent or conductor review decision; meta.round,
///   meta.commit (the HEAD it reviewed), meta.by
/// - approved: a human (or conductor) approved the ticket
/// - message: legacy. A human's message logged from the Spec or Activity tab; only older services
///   wrote it (POST /messages no longer logs to Activity), kept so older tickets still decode
/// - answer: legacy. The agent's final answer to such a message, written only by older services
/// - reopened: a done ticket went back to work; the notes
/// - moved: a column change no other entry records (a drag, Start, Completed); meta.from and
///   meta.to, and a one-line body that may be empty
/// - failed: a run failed
/// - permission: a tool approval was asked for or answered
/// - system: anything else the service records
public enum ActivityKind: OpenEnum {
    case note, submitted, specRevised, blocked, unblocked, reviewApproved, changesRequested, approved
    case message, answer, reopened, moved, failed, permission, system
    case unknown(String)
    public static let allKnown: [Self] = [
        .note, .submitted, .specRevised, .blocked, .unblocked, .reviewApproved, .changesRequested, .approved,
        .message, .answer, .reopened, .moved, .failed, .permission, .system,
    ]
    public var rawValue: String {
        switch self {
        case .note: "note"
        case .submitted: "submitted"
        case .specRevised: "spec_revised"
        case .blocked: "blocked"
        case .unblocked: "unblocked"
        case .reviewApproved: "review_approved"
        case .changesRequested: "changes_requested"
        case .approved: "approved"
        case .message: "message"
        case .answer: "answer"
        case .reopened: "reopened"
        case .moved: "moved"
        case .failed: "failed"
        case .permission: "permission"
        case .system: "system"
        case let .unknown(r): r
        }
    }
}

/// Who wrote a spec revision.
public enum SpecRevisionAuthor: OpenEnum {
    case agent, human, system
    case unknown(String)
    public static let allKnown: [Self] = [.agent, .human, .system]
    public var rawValue: String {
        switch self {
        case .agent: "agent"
        case .human: "human"
        case .system: "system"
        case let .unknown(r): r
        }
    }
}

public enum AttachmentKind: OpenEnum {
    case image, video, file
    case unknown(String)
    public static let allKnown: [Self] = [.image, .video, .file]
    public var rawValue: String {
        switch self {
        case .image: "image"
        case .video: "video"
        case .file: "file"
        case let .unknown(r): r
        }
    }
}

/// Attachment.source, where its file lives (DESIGN.md "Attachments"): "spec" was copied into the
/// harness's attachments folder for a spec (lives until its ticket is deleted); "file" was already
/// on disk and is referenced in place (it can go missing); "upload" was stored by POST /uploads
/// (deleted with the last ticket that uses it).
public enum AttachmentSource: OpenEnum {
    case spec, file, upload
    case unknown(String)
    public static let allKnown: [Self] = [.spec, .file, .upload]
    public var rawValue: String {
        switch self {
        case .spec: "spec"
        case .file: "file"
        case .upload: "upload"
        case let .unknown(r): r
        }
    }
}

/// Watcher.mode. "loop": run, read output until exit, re-run immediately (for blocking or
/// long-running commands). "interval": run every intervalSec seconds.
public enum WatcherMode: OpenEnum {
    case loop, interval
    case unknown(String)
    public static let allKnown: [Self] = [.loop, .interval]
    public var rawValue: String {
        switch self {
        case .loop: "loop"
        case .interval: "interval"
        case let .unknown(r): r
        }
    }
}

/// WatcherLive.state
public enum WatcherLiveState: OpenEnum {
    case running, waiting, stopped
    case unknown(String)
    public static let allKnown: [Self] = [.running, .waiting, .stopped]
    public var rawValue: String {
        switch self {
        case .running: "running"
        case .waiting: "waiting"
        case .stopped: "stopped"
        case let .unknown(r): r
        }
    }
}

/// Every prompt the user can override. `system.*` are sections of a run's system prompt (the
/// service decides which sections a run gets and their order); `run.*` are the message that
/// starts a run. GET /prompts describes each one.
public enum PromptId: OpenEnum {
    case systemIntro, systemContext, systemLifecycle, systemPlan, systemWork, systemReview
    case systemCompleteMerge, systemCompletePr, systemCompleteCleanup, systemCompleteCustom, systemConductor, systemChat
    case systemTriage, systemChildren, systemBranches, systemFiles, systemSpec, systemFileLinks
    case systemBoard, systemBoardChanges, systemConfig, systemApprovals, systemBrowser
    case runWorkStart, runConductorStart, runReview, runCompleteMerge, runCompletePr, runCompleteCleanup, runCompleteCustom
    case runConductorUpdate, runChangesRequested, runReopen, runTriage
    case unknown(String)
    /// PROMPT_IDS, in order
    public static let allKnown: [Self] = [
        .systemIntro, .systemContext, .systemLifecycle, .systemPlan, .systemWork, .systemReview,
        .systemCompleteMerge, .systemCompletePr, .systemCompleteCleanup, .systemCompleteCustom, .systemConductor, .systemChat,
        .systemTriage, .systemChildren, .systemBranches, .systemFiles, .systemSpec, .systemFileLinks,
        .systemBoard, .systemBoardChanges, .systemConfig, .systemApprovals, .systemBrowser,
        .runWorkStart, .runConductorStart, .runReview, .runCompleteMerge, .runCompletePr, .runCompleteCleanup, .runCompleteCustom,
        .runConductorUpdate, .runChangesRequested, .runReopen, .runTriage,
    ]
    public var rawValue: String {
        switch self {
        case .systemIntro: "system.intro"
        case .systemContext: "system.context"
        case .systemLifecycle: "system.lifecycle"
        case .systemPlan: "system.plan"
        case .systemWork: "system.work"
        case .systemReview: "system.review"
        case .systemCompleteMerge: "system.complete_merge"
        case .systemCompletePr: "system.complete_pr"
        case .systemCompleteCleanup: "system.complete_cleanup"
        case .systemCompleteCustom: "system.complete_custom"
        case .systemConductor: "system.conductor"
        case .systemChat: "system.chat"
        case .systemTriage: "system.triage"
        case .systemChildren: "system.children"
        case .systemBranches: "system.branches"
        case .systemFiles: "system.files"
        case .systemSpec: "system.spec"
        case .systemFileLinks: "system.file_links"
        case .systemBoard: "system.board"
        case .systemBoardChanges: "system.board_changes"
        case .systemConfig: "system.config"
        case .systemApprovals: "system.approvals"
        case .systemBrowser: "system.browser"
        case .runWorkStart: "run.work_start"
        case .runConductorStart: "run.conductor_start"
        case .runReview: "run.review"
        case .runCompleteMerge: "run.complete_merge"
        case .runCompletePr: "run.complete_pr"
        case .runCompleteCleanup: "run.complete_cleanup"
        case .runCompleteCustom: "run.complete_custom"
        case .runConductorUpdate: "run.conductor_update"
        case .runChangesRequested: "run.changes_requested"
        case .runReopen: "run.reopen"
        case .runTriage: "run.triage"
        case let .unknown(r): r
        }
    }
}

public enum PromptGroup: OpenEnum {
    case system, run
    case unknown(String)
    public static let allKnown: [Self] = [.system, .run]
    public var rawValue: String {
        switch self {
        case .system: "system"
        case .run: "run"
        case let .unknown(r): r
        }
    }
}

/// localhost → 127.0.0.1 · tailscale → the Tailscale IPv4 + 127.0.0.1 · any → 0.0.0.0 ·
/// custom → `host` (must be a local interface address) + 127.0.0.1.
public enum ListenMode: OpenEnum {
    case localhost, tailscale, any, custom
    case unknown(String)
    /// LISTEN_MODES
    public static let allKnown: [Self] = [.localhost, .tailscale, .any, .custom]
    public var rawValue: String {
        switch self {
        case .localhost: "localhost"
        case .tailscale: "tailscale"
        case .any: "any"
        case .custom: "custom"
        case let .unknown(r): r
        }
    }
}

/// FileMatch.kind and FileSearchOptions.kind
public enum FileKind: OpenEnum {
    case file, dir
    case unknown(String)
    public static let allKnown: [Self] = [.file, .dir]
    public var rawValue: String {
        switch self {
        case .file: "file"
        case .dir: "dir"
        case let .unknown(r): r
        }
    }
}

/// HumanReviewBody.decision
public enum HumanReviewDecision: OpenEnum {
    case approve, requestChanges
    case unknown(String)
    public static let allKnown: [Self] = [.approve, .requestChanges]
    public var rawValue: String {
        switch self {
        case .approve: "approve"
        case .requestChanges: "request_changes"
        case let .unknown(r): r
        }
    }
}

/// ApprovalBody.decision. allow_once: this exact call; allow_tool: every future call of this tool
/// on this ticket; deny
public enum ApprovalDecision: OpenEnum {
    case allowOnce, allowTool, deny
    case unknown(String)
    public static let allKnown: [Self] = [.allowOnce, .allowTool, .deny]
    public var rawValue: String {
        switch self {
        case .allowOnce: "allow_once"
        case .allowTool: "allow_tool"
        case .deny: "deny"
        case let .unknown(r): r
        }
    }
}

/// When a plugin tab shows on a ticket (evaluated by the service in GET /tickets/:key/tabs):
/// - "always":   every ticket
/// - "workdir":  ticket.workdir is set, exists on disk, and is inside a git work tree
/// - "worktree": ticket.branch is set and ticket.workdir exists on disk (the ticket's own git
///               worktree: a harness worktree, or the one update_branch re-pointed it to)
public enum TicketTabWhen: OpenEnum {
    case always, workdir, worktree
    case unknown(String)
    public static let allKnown: [Self] = [.always, .workdir, .worktree]
    public var rawValue: String {
        switch self {
        case .always: "always"
        case .workdir: "workdir"
        case .worktree: "worktree"
        case let .unknown(r): r
        }
    }
}

/// PluginInfo.source: "builtin" (<repo>/plugins) or "user" ($HARNESS_HOME/plugins)
public enum PluginSource: OpenEnum {
    case builtin, user
    case unknown(String)
    public static let allKnown: [Self] = [.builtin, .user]
    public var rawValue: String {
        switch self {
        case .builtin: "builtin"
        case .user: "user"
        case let .unknown(r): r
        }
    }
}

/// The resolved appearance sent to plugins (`theme: "light" | "dark"`).
public enum Appearance: OpenEnum {
    case light, dark
    case unknown(String)
    public static let allKnown: [Self] = [.light, .dark]
    public var rawValue: String {
        switch self {
        case .light: "light"
        case .dark: "dark"
        case let .unknown(r): r
        }
    }
}

/// BrowserInput mouse `action`
public enum MouseAction: OpenEnum {
    case move, down, up, wheel
    case unknown(String)
    public static let allKnown: [Self] = [.move, .down, .up, .wheel]
    public var rawValue: String {
        switch self {
        case .move: "move"
        case .down: "down"
        case .up: "up"
        case .wheel: "wheel"
        case let .unknown(r): r
        }
    }
}

/// BrowserInput mouse `button`
public enum MouseButton: OpenEnum {
    case left, right, middle
    case unknown(String)
    public static let allKnown: [Self] = [.left, .right, .middle]
    public var rawValue: String {
        switch self {
        case .left: "left"
        case .right: "right"
        case .middle: "middle"
        case let .unknown(r): r
        }
    }
}

/// BrowserInput key `action`
public enum KeyAction: OpenEnum {
    case down, up
    case unknown(String)
    public static let allKnown: [Self] = [.down, .up]
    public var rawValue: String {
        switch self {
        case .down: "down"
        case .up: "up"
        case let .unknown(r): r
        }
    }
}

/// BrowserSize `device`: the tab's input mode ("desktop" = a fine pointer, "mobile" = touch
/// emulation and an iPhone user agent)
public enum BrowserDevice: OpenEnum {
    case desktop, mobile
    case unknown(String)
    public static let allKnown: [Self] = [.desktop, .mobile]
    public var rawValue: String {
        switch self {
        case .desktop: "desktop"
        case .mobile: "mobile"
        case let .unknown(r): r
        }
    }
}
