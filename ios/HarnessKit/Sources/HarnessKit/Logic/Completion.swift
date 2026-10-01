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

        public init(completionAction: CompletionAction? = nil, pullRequestUrl: String? = nil, baseBranch: String? = nil) {
            self.completionAction = completionAction
            self.pullRequestUrl = pullRequestUrl
            self.baseBranch = baseBranch
        }

        public init(_ ticket: Ticket) {
            self.init(completionAction: ticket.completionAction.optional, pullRequestUrl: ticket.pullRequestUrl.optional, baseBranch: ticket.baseBranch.optional)
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

    /// The actions a project offers from what its checkout supports: custom only outside git; merge and
    /// custom in a git repo; pr as well when a pull request can be opened (`pullRequestHost`). Uses the
    /// service's list when it sent one.
    public static func offeredCompletionActions(_ project: ProjectInfo?) -> [CompletionAction] {
        if let list = project?.completionActions { return list }
        if project?.isGit == false { return [.custom] }
        return nonEmpty(project?.pullRequestHost) != nil ? [.merge, .pr, .custom] : [.merge, .custom]
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

    /// What approving `ticket` can do. A child whose parent has a branch only merges into it. Otherwise
    /// the project's offered actions, preselecting the ticket's earlier choice, then pr when the ticket
    /// already opened a pull request (so a re-approval updates it), then the project default.
    public static func completionOptions(_ ticket: TicketInfo?, _ project: ProjectInfo?, parent: ParentInfo? = nil) -> Options {
        if let branch = Branches.parentLandingBranch(ticketBaseBranch: ticket?.baseBranch, parentBranch: parent?.branch, parentStatus: parent?.status) {
            return Options(actions: [.merge], defaultAction: .merge, parentBranch: branch)
        }
        let actions = offeredCompletionActions(project)
        var defaultAction = projectCompletionDefault(project)
        if let earlier = ticket?.completionAction, !earlier.rawValue.isEmpty, actions.contains(earlier) {
            defaultAction = earlier
        } else if nonEmpty(ticket?.pullRequestUrl) != nil, actions.contains(.pr) {
            defaultAction = .pr
        }
        return Options(actions: actions, defaultAction: defaultAction, parentBranch: nil)
    }

    /// `completionOptions` for protocol entities.
    public static func completionOptions(ticket: Ticket?, project: Project?, parent: Ticket? = nil) -> Options {
        completionOptions(ticket.map(TicketInfo.init), project.map(ProjectInfo.init), parent: parent.map(ParentInfo.init))
    }

    /// The action a completion uses: `requested` when given (nil plus the reason when the ticket
    /// doesn't offer it), else the preselected one.
    public static func resolveCompletionAction(_ requested: CompletionAction?, _ ticket: TicketInfo?, _ project: ProjectInfo?, parent: ParentInfo? = nil) -> Resolution {
        let opts = completionOptions(ticket, project, parent: parent)
        guard let requested, !requested.rawValue.isEmpty else { return Resolution(action: opts.defaultAction, error: nil) }
        if opts.actions.contains(requested) { return Resolution(action: requested, error: nil) }
        return Resolution(action: nil, error: completionRefusal(requested, opts))
    }

    private static func completionRefusal(_ action: CompletionAction, _ opts: Options) -> String {
        if let branch = opts.parentBranch, !branch.isEmpty {
            return "this ticket merges into its parent's branch \(branch), so it can't complete with \"\(action.rawValue)\""
        }
        if action == .pr { return "\"pr\" needs a git remote on a host gh is logged into (run gh auth login)" }
        if action == .merge { return "\"merge\" needs a git repository" }
        return "\"\(action.rawValue)\" isn't offered here (offered: \(opts.actions.map(\.rawValue).joined(separator: ", ")))"
    }

    /// Menu and button labels for each choice (COMPLETION_ACTION_LABELS).
    public static let completionActionLabels: [CompletionAction: String] = [
        .merge: "Approve and merge",
        .pr: "Approve and open PR",
        .custom: "Approve and…",
    ]

    /// `COMPLETION_ACTION_LABELS[action]`: nil for an action this build doesn't know.
    public static func label(for action: CompletionAction) -> String? {
        completionActionLabels[action]
    }

    /// The last, separate choice: approve and mark done without a completion run.
    public static let approveNoActionLabel = "Approve and take no action"

    /// The Approve button's primary label for the preselected action: "Approve and merge into
    /// harness/web-1" for a child on its parent's branch, a plain "Approve" when custom is the only
    /// choice (no git: a light wrap-up), else the action's label (nil for an unknown action).
    public static func approveLabel(_ opts: Options) -> String? {
        if let branch = nonEmpty(opts.parentBranch) { return "Approve and merge into \(branch)" }
        if opts.defaultAction == .custom { return "Approve" }
        return label(for: opts.defaultAction)
    }

    /// The Approve menu's choices, in order (merge, pr, then custom as "Approve and…", which asks for
    /// instructions). Empty for a child on its parent's branch: it only merges. "Approve and take no
    /// action" always follows them, after a separator.
    public static func approveMenuActions(_ opts: Options) -> [CompletionAction] {
        nonEmpty(opts.parentBranch) != nil ? [] : opts.actions
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}
