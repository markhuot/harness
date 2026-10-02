import Foundation

// Port of shared/src/state/drafts.ts. Drafts (DESIGN.md "Drafts") and the ticket settings both
// apps render in ticket details and in a draft's Options: a draft is a planning ticket with
// `draft` set, edited through the same TicketSettings rows as any ticket. These are the pure
// pieces: the blank draft a New session starts from, applying a settings PATCH locally, the POST /
// PATCH bodies a draft editor sends, which settings rows show (and can change), the branch pick's
// meaning, and the collapsed Options summary.

/// The settings a draft reads: `Pick<PublicSettings, "defaultDriver" | "defaultModels" | "baseBranch">`.
public struct DraftSettings: Codable, Sendable, Equatable {
    public var defaultDriver: String
    public var defaultModels: [String: String?]
    public var baseBranch: String?

    public init(defaultDriver: String, defaultModels: [String: String?] = [:], baseBranch: String? = nil) {
        self.defaultDriver = defaultDriver
        self.defaultModels = defaultModels
        self.baseBranch = baseBranch
    }

    public init(_ settings: PublicSettings) {
        self.init(defaultDriver: settings.defaultDriver, defaultModels: settings.defaultModels, baseBranch: settings.baseBranch)
    }
}

public enum Drafts {
    /// The review switches a new ticket of `project` starts with (Project.skipAgentReview / skipHumanReview).
    public static func projectReviewSkips(_ project: Project?) -> (skipAgentReview: Bool, skipHumanReview: Bool) {
        (project?.skipAgentReview == true, project?.skipHumanReview == true)
    }

    /// The review switches for a draft moving from project `from` to `to`: a switch still on its old
    /// project's default follows the new project's, and one the user flipped stays flipped. Only the
    /// switches that change, so it merges into the move's PATCH.
    public static func draftReviewSkipsPatch(_ t: Ticket, from: Project?, to: Project?) -> UpdateTicketBody {
        let was = projectReviewSkips(from)
        let next = projectReviewSkips(to)
        var p = UpdateTicketBody()
        if (t.skipAgentReview == true) == was.skipAgentReview, was.skipAgentReview != next.skipAgentReview { p.skipAgentReview = next.skipAgentReview }
        if (t.skipHumanReview == true) == was.skipHumanReview, was.skipHumanReview != next.skipHumanReview { p.skipHumanReview = next.skipHumanReview }
        return p
    }

    /// The ticket a New session edits before anything is saved: a draft in planning with every
    /// setting inherited, and the project's review switches. `key` is the predicted key
    /// (`Branches.predictedTicketKey`), used only for the harness/<key> label.
    public static func blankDraftTicket(project: Project, settings: DraftSettings?, key: String, now: Double = Date().timeIntervalSince1970 * 1000) -> Ticket {
        let skips = projectReviewSkips(project)
        return Ticket(
            id: "", key: key, projectId: project.id, kind: .task, title: "", description: "", status: .planning,
            sessionId: "", driver: projectDriver(project, settings), parentId: nil, childCount: 0, dependsOn: [],
            autoStart: false, agentReview: .pending, humanReview: .pending, externalRef: nil, workdir: nil, branch: nil,
            requestedBranch: .null, baseBranch: .null, useWorktree: .null, skipAgentReview: skips.skipAgentReview, skipHumanReview: skips.skipHumanReview, draft: true,
            blockedReason: nil, busy: false, pendingApproval: nil, allowedTools: [], permissionMode: nil, model: nil,
            position: 0, createdAt: now, updatedAt: now
        )
    }

    /// `patch` (what TicketSettings asks the service for) applied to a local ticket, the way the
    /// service applies it: a driver change clears the model unless one comes with it, "" branches
    /// mean the default. A draft editor keeps its unsaved state this way. `.absent` leaves a field
    /// alone and `.null` clears it.
    public static func applyTicketPatch(_ t: Ticket, _ patch: UpdateTicketBody) -> Ticket {
        var next = t
        if let title = patch.title { next.title = title }
        if let description = patch.description { next.description = description }
        if let driver = patch.driver, !Branches.jsEqual(driver, t.driver) {
            next.driver = driver
            if !patch.model.isPresent { next.model = nil }
        }
        if patch.model.isPresent { next.model = Branches.nonEmpty(patch.model.optional) }
        if patch.permissionMode.isPresent { next.permissionMode = patch.permissionMode.optional }
        if patch.baseBranch.isPresent { next.baseBranch = Patch(blankToNil(patch.baseBranch.optional)) }
        if patch.branch.isPresent { next.requestedBranch = Patch(blankToNil(patch.branch.optional)) }
        if let skip = patch.skipAgentReview { next.skipAgentReview = skip }
        if let skip = patch.skipHumanReview { next.skipHumanReview = skip }
        if let deps = patch.dependsOn { next.dependsOn = deps }
        if let position = patch.position { next.position = position }
        if let kind = patch.kind { next.kind = kind }
        if patch.useWorktree.isPresent { next.useWorktree = patch.useWorktree }
        if let projectId = patch.projectId { next.projectId = projectId }
        return next
    }

    /// Whether the ticket will work in a worktree of its own (a git project, and its pick or the
    /// project's says so).
    public static func draftUsesWorktree(_ t: Ticket, project: Project?) -> Bool {
        guard let project, project.isGit != false else { return false }
        return t.useWorktree.optional ?? project.useWorktrees
    }

    /// Nothing worth keeping: no prompt, every setting still inherited and the review switches on
    /// the project's defaults. A New session isn't saved until this turns false, and closing one
    /// that's still empty doesn't ask.
    public static func draftIsEmpty(_ t: Ticket, project: Project?, settings: DraftSettings?) -> Bool {
        let skips = projectReviewSkips(project)
        return JSCompat.trim(t.description).isEmpty
            && t.kind == .task
            && choiceDriver(t, project, settings) == nil
            && t.permissionMode == nil
            && t.useWorktree.optional == nil
            && Branches.nonEmpty(t.requestedBranch.optional) == nil
            && Branches.nonEmpty(t.baseBranch.optional) == nil
            && (t.skipAgentReview == true) == skips.skipAgentReview
            && (t.skipHumanReview == true) == skips.skipHumanReview
            && t.dependsOn.isEmpty
    }

    /// POST /tickets for a draft's first save. Branch and base go only with a worktree (the
    /// service refuses a branch without one), and useWorktree only for a git project. Both review
    /// switches always go: the service would fill in its own copy of the project's defaults otherwise.
    public static func draftCreateBody(_ t: Ticket, project: Project) -> CreateTicketBody {
        let worktree = draftUsesWorktree(t, project: project)
        return CreateTicketBody(
            projectId: t.projectId,
            prompt: t.description,
            kind: t.kind,
            driver: Branches.nonEmpty(t.driver),
            model: Patch(t.model),
            permissionMode: Patch(t.permissionMode),
            start: false,
            useWorktree: project.isGit == false ? .null : Patch(t.useWorktree.optional),
            branch: worktree ? Patch(t.requestedBranch.optional) : .absent,
            baseBranch: worktree ? Patch(t.baseBranch.optional) : .absent,
            skipAgentReview: t.skipAgentReview == true,
            skipHumanReview: t.skipHumanReview == true,
            dependsOn: t.dependsOn.isEmpty ? nil : t.dependsOn,
            draft: true
        )
    }

    /// The PATCH taking a saved draft from `prev` (what the service has) to `next` (the editor's
    /// state): only the fields that changed, or nil when nothing did. The title isn't sent: the
    /// service re-derives a draft's title from its prompt.
    public static func draftPatch(_ prev: Ticket, _ next: Ticket) -> UpdateTicketBody? {
        var p = UpdateTicketBody()
        if !Branches.jsEqual(next.projectId, prev.projectId) { p.projectId = next.projectId }
        if !Branches.jsEqual(next.description, prev.description) { p.description = next.description }
        if next.kind != prev.kind { p.kind = next.kind }
        if !Branches.jsEqual(next.driver, prev.driver) { p.driver = next.driver }
        if !optionalEqual(next.model, prev.model) || (p.driver != nil && Branches.nonEmpty(next.model) != nil) { p.model = Patch(next.model) }
        if next.permissionMode != prev.permissionMode { p.permissionMode = Patch(next.permissionMode) }
        if next.useWorktree.optional != prev.useWorktree.optional { p.useWorktree = Patch(next.useWorktree.optional) }
        if !optionalEqual(next.requestedBranch.optional, prev.requestedBranch.optional) { p.branch = Patch(next.requestedBranch.optional) }
        if !optionalEqual(next.baseBranch.optional, prev.baseBranch.optional) { p.baseBranch = Patch(next.baseBranch.optional) }
        if (next.skipAgentReview == true) != (prev.skipAgentReview == true) { p.skipAgentReview = next.skipAgentReview == true }
        if (next.skipHumanReview == true) != (prev.skipHumanReview == true) { p.skipHumanReview = next.skipHumanReview == true }
        if !next.dependsOn.elementsEqual(prev.dependsOn, by: Branches.jsEqual) { p.dependsOn = next.dependsOn }
        return p == UpdateTicketBody() ? nil : p
    }

    /// Which TicketSettings rows show, and which can change, for a ticket (a draft or not).
    public struct TicketSettingsRows: Codable, Sendable, Equatable {
        public struct Branch: Codable, Sendable, Equatable {
            public var show: Bool
            public var editable: Bool
            public var offerCheckout: Bool
            public init(show: Bool, editable: Bool, offerCheckout: Bool) {
                self.show = show
                self.editable = editable
                self.offerCheckout = offerCheckout
            }
        }

        public struct Base: Codable, Sendable, Equatable {
            public var show: Bool
            public var editable: Bool
            public init(show: Bool, editable: Bool) {
                self.show = show
                self.editable = editable
            }
        }

        /// Anything can change: the ticket isn't done
        public var editable: Bool
        /// The driver can't change mid-run: the Model menu offers only this driver's models
        public var onlyDriver: String?
        /// The ticket works (or will work) in a worktree of its own
        public var worktree: Bool
        /// The Branch row. A draft always shows it on a git project, since picking the project
        /// directory's own branch (`offerCheckout`) is how it chooses to run without a worktree.
        public var branch: Branch
        /// The Base branch row: only with a worktree (nothing merges otherwise)
        public var base: Base

        public init(editable: Bool, onlyDriver: String?, worktree: Bool, branch: Branch, base: Base) {
            self.editable = editable
            self.onlyDriver = onlyDriver
            self.worktree = worktree
            self.branch = branch
            self.base = base
        }
    }

    public static func ticketSettingsRows(_ t: Ticket, project: Project?) -> TicketSettingsRows {
        let editable = t.status != .done
        let draft = t.draft == true
        let worktree = draft ? draftUsesWorktree(t, project: project) : Branches.ticketHasBranch(t, project: project)
        let gitProject = project != nil && project?.isGit != false
        return TicketSettingsRows(
            editable: editable,
            onlyDriver: t.busy ? t.driver : nil,
            worktree: worktree,
            branch: draft
                ? .init(show: gitProject, editable: editable, offerCheckout: true)
                : .init(show: worktree, editable: Branches.canChangeBranch(t, project: project), offerCheckout: false),
            base: .init(show: worktree, editable: editable)
        )
    }

    /// A pick in a draft's Branch row: the default, the project directory's own branch, or any other.
    public enum DraftBranchPick: Codable, Sendable, Equatable {
        case `default`
        case checkout
        case branch(name: String)

        private enum CodingKeys: String, CodingKey { case kind, name }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "default": self = .default
            case "checkout": self = .checkout
            case "branch": self = .branch(name: try c.decode(String.self, forKey: .name))
            case let other: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown branch pick \(other)")
            }
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .default: try c.encode("default", forKey: .kind)
            case .checkout: try c.encode("checkout", forKey: .kind)
            case let .branch(name):
                try c.encode("branch", forKey: .kind)
                try c.encode(name, forKey: .name)
            }
        }
    }

    /// What a pick in the Branch row picked, given the project directory's branch (nil while unknown).
    public static func draftBranchPick(_ name: String?, checkout: BranchInfo?) -> DraftBranchPick {
        guard let name else { return .default }
        if let checkout, Branches.jsEqual(name, checkout.name) { return .checkout }
        return .branch(name: name)
    }

    /// The PATCH for a pick in a draft's Branch row. The project directory's own branch means no
    /// worktree; any other branch means a worktree on it. useWorktree stays null whenever the pick
    /// is what the project does anyway, so the draft keeps following the project.
    public static func draftBranchPatch(_ pick: DraftBranchPick, project: Project) -> UpdateTicketBody {
        switch pick {
        case .default:
            UpdateTicketBody(branch: .null, useWorktree: .null)
        case .checkout:
            UpdateTicketBody(branch: .null, useWorktree: project.useWorktrees ? .value(false) : .null)
        case let .branch(name):
            UpdateTicketBody(branch: .value(name), useWorktree: project.useWorktrees ? .null : .value(true))
        }
    }

    /// The Branch row's value for a draft: its requested branch, or the project directory's branch
    /// when it picked that over the project's worktree default. nil shows the default row.
    public static func draftBranchValue(_ t: Ticket, project: Project, checkout: BranchInfo?) -> String? {
        if t.useWorktree.optional == false && project.useWorktrees { return checkout?.name }
        return t.requestedBranch.optional
    }

    /// The Branch row's default option for a draft: the project's own choice between a new branch
    /// and the project directory.
    public static func draftDefaultBranchLabel(key: String, project: Project, checkout: BranchInfo?) -> String {
        if project.useWorktrees { return "New branch \(Branches.harnessBranch(key))" }
        if let checkout { return "\(checkout.name) · project directory" }
        return "Project directory"
    }

    /// What the ticket's branch pick will do (the line under the Branch row). A draft without a
    /// worktree works in the project directory on its branch.
    public static func ticketBranchChoice(_ t: Ticket, project: Project, known: [BranchInfo], checkout: BranchInfo?) -> BranchChoice {
        let draft = t.draft == true
        if draft && !draftUsesWorktree(t, project: project) {
            return .checkout(name: checkout?.name ?? "its current branch", path: checkout?.checkedOutAt ?? project.path)
        }
        return Branches.branchChoice(t.requestedBranch.optional, defaultName: Branches.harnessBranch(t.key), known: known, checkoutPath: draft ? project.path : nil)
    }

    /// The branch hint for a ticket, with its resolved base branch.
    public static func ticketBranchHint(_ t: Ticket, project: Project, settings: DraftSettings?, known: [BranchInfo], checkout: BranchInfo?) -> BranchHint {
        let base = Branches.resolveBaseBranch(ticket: t, project: project, settingsBaseBranch: settings?.baseBranch)
        return Branches.branchChoiceHint(ticketBranchChoice(t, project: project, known: known, checkout: checkout), base: base.branch)
    }

    /// A branch hint that shouldn't sit hidden in a collapsed Options: the pick would block, or isn't valid.
    public static func optionsNeedAttention(_ tone: BranchHint.Tone) -> Bool {
        tone != .plain
    }

    public static func optionsNeedAttention(_ hint: BranchHint) -> Bool {
        optionsNeedAttention(hint.tone)
    }

    public struct OptionsSummaryLabels {
        /// A model's display name ("Sonnet 5"); the id is shown without it
        public var model: ((_ driver: String, _ model: String?) -> String?)?
        /// A driver's display name
        public var driver: ((_ driver: String) -> String)?
        /// The project directory's branch, for "main · no worktree"
        public var checkoutName: String?

        public init(model: ((String, String?) -> String?)? = nil, driver: ((String) -> String)? = nil, checkoutName: String? = nil) {
            self.model = model
            self.driver = driver
            self.checkoutName = checkoutName
        }
    }

    /// The collapsed Options line: only what differs from the project's defaults, in row order,
    /// e.g. ["Sonnet 5", "Read only", "main · no worktree", "Skip agent review"]. Empty when nothing does.
    public static func newSessionOptionsSummary(_ t: Ticket, project: Project, settings: DraftSettings?, labels: OptionsSummaryLabels = .init()) -> [String] {
        var out: [String] = []
        if let driver = Branches.nonEmpty(choiceDriver(t, project, settings)) {
            let model = t.model
            let text = Branches.nonEmpty(labels.model?(driver, model) ?? nil)
                ?? Branches.nonEmpty(model)
                ?? Branches.nonEmpty(labels.driver?(driver))
                ?? driver
            out.append(text)
        }
        if let mode = t.permissionMode, !mode.rawValue.isEmpty { out.append(permissionModeLabel(mode)) }
        if project.isGit != false {
            let worktree = draftUsesWorktree(t, project: project)
            let requested = Branches.nonEmpty(t.requestedBranch.optional)
            if !worktree && t.useWorktree.optional == false {
                out.append("\(labels.checkoutName ?? "Project directory") · no worktree")
            } else if worktree, let requested {
                out.append(requested)
            } else if worktree && t.useWorktree.optional == true {
                out.append(Branches.harnessBranch(t.key))
            }
            if worktree, let base = Branches.nonEmpty(t.baseBranch.optional) { out.append("into \(base)") }
        }
        let skips = projectReviewSkips(project)
        let skipAgent = t.skipAgentReview == true
        let skipHuman = t.skipHumanReview == true
        if skipAgent != skips.skipAgentReview { out.append(skipAgent ? "Skip agent review" : "With agent review") }
        if skipHuman != skips.skipHumanReview { out.append(skipHuman ? "Skip human review" : "With human review") }
        if !t.dependsOn.isEmpty { out.append("After \(t.dependsOn.joined(separator: ", "))") }
        return out
    }

    // MARK: Helpers (models.ts / format.ts pieces drafts.ts uses)

    /// models.ts `projectDriver`: the project's own default, else the settings default.
    static func projectDriver(_ project: Project?, _ settings: DraftSettings?) -> String {
        Branches.nonEmpty(project?.defaultDriver) ?? Branches.nonEmpty(settings?.defaultDriver) ?? ""
    }

    /// models.ts `ticketChoice(...).driver`: nil (Default) when the ticket sits on its project's
    /// driver without a model of its own.
    static func choiceDriver(_ t: Ticket, _ project: Project?, _ settings: DraftSettings?) -> String? {
        if Branches.nonEmpty(t.model) == nil && Branches.jsEqual(t.driver, projectDriver(project, settings)) { return nil }
        return t.driver
    }

    /// format.ts `permissionModeLabel`.
    static func permissionModeLabel(_ mode: PermissionMode) -> String {
        Permissions.label(for: mode)?.label ?? mode.rawValue
    }

    private static func blankToNil(_ v: String?) -> String? {
        Branches.nonEmpty(v.map(JSCompat.trim))
    }

    private static func optionalEqual(_ a: String?, _ b: String?) -> Bool {
        switch (a, b) {
        case (nil, nil): true
        case let (a?, b?): Branches.jsEqual(a, b)
        default: false
        }
    }
}
