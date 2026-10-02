import Foundation

// Port of shared/src/completion.ts: how an approved ticket's work lands (DESIGN.md "Completion"),
// shared by the service (which validates a choice and picks the completion prompts) and the apps
// (which build the Approve menu).
//
// JS truthiness matters: `project?.completionActions` is truthy for an empty list (so [] wins over
// the client's guess), while `pullRequestHost`, `pullRequestUrl`, a parent's `branch` and a child's
// `baseBranch` are falsy when "". Unknown actions (a newer service) have no label: TS reads
// `COMPLETION_ACTION_LABELS[action]` as undefined, so `label(for:)` and `approveLabel` return nil.

public enum Completion {
    /// The project fields completion reads (TS `ProjectLike`). Property names match the JSON keys.
    public struct ProjectInfo: Codable, Sendable, Equatable {
        public var isGit: Bool?
        public var completionAction: CompletionAction?
        public var completionActions: [CompletionAction]?
        public var pullRequestHost: String?

        public init(isGit: Bool? = nil, completionAction: CompletionAction? = nil, completionActions: [CompletionAction]? = nil, pullRequestHost: String? = nil) {
            self.isGit = isGit
            self.completionAction = completionAction
            self.completionActions = completionActions
            self.pullRequestHost = pullRequestHost
        }

        public init(_ project: Project) {
            self.init(isGit: project.isGit, completionAction: project.completionAction, completionActions: project.completionActions, pullRequestHost: project.pullRequestHost.optional)
        }
    }

    /// The ticket fields completion reads (TS `TicketLike`).
    public struct TicketInfo: Codable, Sendable, Equatable {
        public var completionAction: CompletionAction?
        public var pullRequestUrl: String?
        public var baseBranch: String?
        /// The ticket's own branch (its worktree's). `.null` means it has none (`hasNoBranch`);
        /// `.absent` means the caller didn't say.
        public var branch: Patch<String>
        /// Whether its worktree has anything to land (Ticket.hasChanges); only false matters.
        public var hasChanges: Bool?

        public init(completionAction: CompletionAction? = nil, pullRequestUrl: String? = nil, baseBranch: String? = nil, branch: Patch<String> = .absent, hasChanges: Bool? = nil) {
            self.completionAction = completionAction
            self.pullRequestUrl = pullRequestUrl
            self.baseBranch = baseBranch
            self.branch = branch
            self.hasChanges = hasChanges
        }

        public init(_ ticket: Ticket) {
            self.init(completionAction: ticket.completionAction.optional, pullRequestUrl: ticket.pullRequestUrl.optional, baseBranch: ticket.baseBranch.optional, branch: Patch(ticket.branch), hasChanges: ticket.hasChanges.optional)
        }
    }

    /// The parent fields completion reads (TS `ParentLike`).
    public struct ParentInfo: Codable, Sendable, Equatable {
        public var branch: String?
        public var status: TicketStatus?

        public init(branch: String? = nil, status: TicketStatus? = nil) {
            self.branch = branch
            self.status = status
        }

        public init(_ parent: Ticket) {
            self.init(branch: parent.branch, status: parent.status)
        }
    }

    public struct Options: Codable, Sendable, Equatable {
        /// The actions this ticket may complete with, in menu order
        public var actions: [CompletionAction]
        /// The one preselected (the Approve button's primary action)
        public var defaultAction: CompletionAction
        /// Set when the ticket is a child that lands on its parent's branch (`parentLandingBranch`: the
        /// parent works on a branch of its own and isn't done, and the child sets no base branch of its
        /// own): it always merges into that branch (so a conductor stays on one branch), and this is the
        /// branch's name.
        @Nullable public var parentBranch: String?

        public init(actions: [CompletionAction], defaultAction: CompletionAction, parentBranch: String? = nil) {
            self.actions = actions
            self.defaultAction = defaultAction
            self.parentBranch = parentBranch
        }
    }

    /// `resolveCompletionAction`'s result: an action, or nil plus the reason it was refused.
    public struct Resolution: Codable, Sendable, Equatable {
        @Nullable public var action: CompletionAction?
        @Nullable public var error: String?

        public init(action: CompletionAction?, error: String?) {
            self.action = action
            self.error = error
        }
    }

    /// The actions a project offers from what its checkout supports: custom only outside git; merge,
    /// cleanup and custom in a git repo; pr as well when a pull request can be opened
    /// (`pullRequestHost`). Uses the service's list when it sent one.
    public static func offeredCompletionActions(_ project: ProjectInfo?) -> [CompletionAction] {
        if let list = project?.completionActions { return list }
        if project?.isGit == false { return [.custom] }
        return nonEmpty(project?.pullRequestHost) != nil ? [.merge, .pr, .cleanup, .custom] : [.merge, .cleanup, .custom]
    }

    /// Whether a string from a request is a completion action at all.
    public static func isCompletionAction(_ value: JSONValue?) -> Bool {
        guard let s = value?.stringValue else { return false }
        return CompletionAction.allKnown.contains { $0.rawValue == s }
    }

    /// A project's effective default: its stored choice while it still offers it, else merge, else
    /// custom (a project that lost its gh login or its remote doesn't break).
    public static func projectCompletionDefault(_ project: ProjectInfo?) -> CompletionAction {
        let offered = offeredCompletionActions(project)
        let stored = project?.completionAction ?? .merge
        if offered.contains(stored) { return stored }
        return offered.contains(.merge) ? .merge : offered.first ?? .custom
    }

    /// Whether the ticket works on its base branch itself (`branch` is the effective base, as on a
    /// ticket made to push to an existing pull request's branch): there's nothing to merge or open a
    /// pull request from.
    public static func worksOnBase(_ ticket: TicketInfo?, base: String?) -> Bool {
        guard let branch = nonEmpty(ticket?.branch.optional), let base = nonEmpty(base) else { return false }
        return branch.utf16.elementsEqual(base.utf16)
    }

    /// Whether the ticket has no branch of its own: `branch` is null (not just left out), so it never
    /// got a worktree. It worked in the project checkout, or outside git, and there's nothing to merge
    /// or open a pull request from.
    public static func hasNoBranch(_ ticket: TicketInfo?) -> Bool {
        if case .null = ticket?.branch { return true }
        return false
    }

    /// Why approving `ticket` has nothing to merge or open a pull request from, or nil when it may:
    /// it works on its base branch, it has no branch of its own, or the service found no changes in
    /// its worktree (`hasChanges` false).
    public static func nothingToLand(_ ticket: TicketInfo?, base: String?) -> String? {
        if worksOnBase(ticket, base: base) { return "this ticket works on its base branch \(base ?? "")" }
        if hasNoBranch(ticket) { return "this ticket has no branch of its own" }
        if ticket?.hasChanges == false { return "this ticket has no changes to land" }
        return nil
    }

    /// What approving `ticket` can do. A child whose parent has a branch only merges into it.
    /// Otherwise the project's offered actions; cleanup always among them, since even a worktree with no
    /// commits (the work was a database or config change outside git) is worth removing. A ticket on
    /// its base branch (`base`, the effective base branch, when the caller knows it), one with no
    /// branch of its own, or one with no changes in its worktree (`nothingToLand`) has nothing to merge
    /// or open a pull request from, so those two drop out. Preselects the ticket's earlier
    /// choice, then pr when the ticket already opened a pull request (so a re-approval updates it),
    /// then the project default, then the first action left.
    public static func completionOptions(_ ticket: TicketInfo?, _ project: ProjectInfo?, parent: ParentInfo? = nil, base: String? = nil) -> Options {
        if let branch = Branches.parentLandingBranch(ticketBaseBranch: ticket?.baseBranch, parentBranch: parent?.branch, parentStatus: parent?.status) {
            return Options(actions: [.merge], defaultAction: .merge, parentBranch: branch)
        }
        let nothing = nothingToLand(ticket, base: base) != nil
        let actions = offeredCompletionActions(project).filter { !(nothing && ($0 == .merge || $0 == .pr)) }
        let projectDefault = projectCompletionDefault(project)
        var defaultAction = actions.contains(projectDefault) ? projectDefault : actions.first ?? .custom
        if let earlier = ticket?.completionAction, !earlier.rawValue.isEmpty, actions.contains(earlier) {
            defaultAction = earlier
        } else if nonEmpty(ticket?.pullRequestUrl) != nil, actions.contains(.pr) {
            defaultAction = .pr
        }
        return Options(actions: actions, defaultAction: defaultAction, parentBranch: nil)
    }

    /// `completionOptions` for protocol entities. `settingsBaseBranch` (PublicSettings.baseBranch)
    /// resolves the ticket's effective base branch, so a ticket on its base branch offers no merge or
    /// pull request.
    public static func completionOptions(ticket: Ticket?, project: Project?, parent: Ticket? = nil, settingsBaseBranch: String? = nil) -> Options {
        let base = ticket.map { Branches.resolveBaseBranch(ticket: $0, project: project, settingsBaseBranch: settingsBaseBranch, parent: parent).branch }
        return completionOptions(ticket.map(TicketInfo.init), project.map(ProjectInfo.init), parent: parent.map(ParentInfo.init), base: base)
    }

    /// The action a completion uses: `requested` when given (nil plus the reason when the ticket
    /// doesn't offer it), else the preselected one.
    public static func resolveCompletionAction(_ requested: CompletionAction?, _ ticket: TicketInfo?, _ project: ProjectInfo?, parent: ParentInfo? = nil, base: String? = nil) -> Resolution {
        let opts = completionOptions(ticket, project, parent: parent, base: base)
        guard let requested, !requested.rawValue.isEmpty else { return Resolution(action: opts.defaultAction, error: nil) }
        if opts.actions.contains(requested) { return Resolution(action: requested, error: nil) }
        return Resolution(action: nil, error: completionRefusal(requested, opts, ticket, project, base: base))
    }

    private static func completionRefusal(_ action: CompletionAction, _ opts: Options, _ ticket: TicketInfo?, _ project: ProjectInfo?, base: String?) -> String {
        if let branch = opts.parentBranch, !branch.isEmpty {
            return "this ticket merges into its parent's branch \(branch), so it can't complete with \"\(action.rawValue)\""
        }
        if offeredCompletionActions(project).contains(action), let why = nothingToLand(ticket, base: base) {
            let what = action == .pr ? "open a pull request from" : "merge"
            return "\(why), so there is nothing to \(what): complete it with \"cleanup\" or \"custom\""
        }
        if action == .pr { return "\"pr\" needs a git remote on a host gh is logged into (run gh auth login)" }
        if action == .merge || action == .cleanup { return "\"\(action.rawValue)\" needs a git repository" }
        return "\"\(action.rawValue)\" isn't offered here (offered: \(opts.actions.map(\.rawValue).joined(separator: ", ")))"
    }

    /// Menu and button labels for each choice (COMPLETION_ACTION_LABELS).
    public static let completionActionLabels: [CompletionAction: String] = [
        .merge: "Approve and merge",
        .pr: "Approve and open PR",
        .cleanup: "Approve and clean up",
        .custom: "Approve and…",
    ]

    /// `COMPLETION_ACTION_LABELS[action]`: nil for an action this build doesn't know.
    public static func label(for action: CompletionAction) -> String? {
        completionActionLabels[action]
    }

    /// The last, separate choice: approve and mark done without a completion run.
    public static let approveNoActionLabel = "Approve and take no action"

    /// The Approve button's primary label for the preselected action: a plain "Approve" when custom is
    /// the choice (no git: a light wrap-up), else the action's label (nil for an unknown action).
    public static func approveLabel(_ opts: Options) -> String? {
        if opts.defaultAction == .custom { return "Approve" }
        return label(for: opts.defaultAction)
    }

    /// The conductor that approves and lands a ticket in the human's place: its parent, until the
    /// parent is done (a done parent runs no more, so the human takes its children back). The apps
    /// disable the Approve button for such a ticket, with `conductorManagedReason`.
    public static func managingConductor(parentId: String?, parentKey: String?, parentStatus: TicketStatus?) -> String? {
        guard nonEmpty(parentId) != nil, let key = parentKey, parentStatus != .done else { return nil }
        return key
    }

    /// `managingConductor` for protocol entities: the parent ticket, or nil.
    public static func managingConductor(ticket: Ticket?, parent: Ticket?) -> Ticket? {
        managingConductor(parentId: ticket?.parentId, parentKey: parent?.key, parentStatus: parent?.status) != nil ? parent : nil
    }

    /// Why the Approve button is disabled on a conductor-managed ticket.
    public static func conductorManagedReason(conductorKey: String) -> String {
        "Conductor managed: \(conductorKey) approves and lands this ticket"
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}
