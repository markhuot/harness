import Foundation

// Port of shared/src/branches.ts: the base branch a ticket's work merges into, the branch a
// ticket works on, and branch-name validation (DESIGN.md "Branches").
//
// JS truthiness matters here: `ticket?.baseBranch` skips null *and* "", so every override is
// read through `nonEmpty`. `plannedBranch` uses `??`, which keeps "". The string checks work on
// Unicode scalars because JS compares code units (Swift's Character would fold a combining mark
// into the "-" or "." before it).

public enum Branches {
    /// Where an effective base branch came from.
    public enum BaseBranchSource: String, Codable, Sendable, Equatable {
        case ticket, parent, project, settings
    }

    public struct ResolvedBaseBranch: Codable, Sendable, Equatable {
        public var branch: String
        public var source: BaseBranchSource
        public init(branch: String, source: BaseBranchSource) {
            self.branch = branch
            self.source = source
        }
    }

    /// The built-in default for settings.baseBranch.
    public static let defaultBaseBranch = "main"

    // MARK: Base branch

    /// The branch a child lands on: its parent's, when the parent works in a worktree of its own
    /// and isn't done, and the child doesn't set its own base branch. nil otherwise.
    public static func parentLandingBranch(ticketBaseBranch: String?, parentBranch: String?, parentStatus: TicketStatus?) -> String? {
        if nonEmpty(ticketBaseBranch) != nil { return nil }
        guard let branch = nonEmpty(parentBranch), parentStatus != .done else { return nil }
        return branch
    }

    /// `parentLandingBranch` for protocol entities.
    public static func parentLandingBranch(ticket: Ticket?, parent: Ticket?) -> String? {
        parentLandingBranch(ticketBaseBranch: ticket?.baseBranch.optional, parentBranch: parent?.branch, parentStatus: parent?.status)
    }

    /// Resolve the base branch: ticket override → the parent ticket's branch (while it has a
    /// worktree and isn't done) → project override → the global setting (default "main").
    /// nil and "" inherit.
    public static func resolveBaseBranch(
        ticket: String?, project: String?, settings: String?, parentBranch: String? = nil, parentStatus: TicketStatus? = nil
    ) -> ResolvedBaseBranch {
        if let b = nonEmpty(ticket) { return ResolvedBaseBranch(branch: b, source: .ticket) }
        if let b = nonEmpty(parentBranch), parentStatus != .done { return ResolvedBaseBranch(branch: b, source: .parent) }
        if let b = nonEmpty(project) { return ResolvedBaseBranch(branch: b, source: .project) }
        return ResolvedBaseBranch(branch: nonEmpty(settings) ?? defaultBaseBranch, source: .settings)
    }

    /// `resolveBaseBranch` for protocol entities. `settingsBaseBranch` is `Settings.baseBranch`
    /// or `PublicSettings.baseBranch`.
    public static func resolveBaseBranch(ticket: Ticket?, project: Project?, settingsBaseBranch: String?, parent: Ticket? = nil) -> ResolvedBaseBranch {
        resolveBaseBranch(
            ticket: ticket?.baseBranch.optional, project: project?.baseBranch.optional, settings: settingsBaseBranch,
            parentBranch: parent?.branch, parentStatus: parent?.status
        )
    }

    // MARK: Ticket branches

    /// The branch the harness creates for a ticket when none is chosen: harness/<key, lower-case>.
    public static func harnessBranch(_ key: String) -> String {
        "harness/\(jsLowerCase(key))"
    }

    /// `String.prototype.toLowerCase()`: Swift's per-scalar full lower-case mapping plus the one
    /// context-sensitive rule JS applies and Swift doesn't, Final_Sigma (ΟΔΟΣ → οδος with ς).
    static func jsLowerCase(_ s: String) -> String {
        let scalars = Array(s.unicodeScalars)
        var out = String.UnicodeScalarView()
        for (i, c) in scalars.enumerated() {
            if c == "\u{03A3}", isFinalSigma(scalars, at: i) {
                out.append("\u{03C2}")
            } else {
                out.append(contentsOf: c.properties.lowercaseMapping.unicodeScalars)
            }
        }
        return String(out)
    }

    /// Unicode's Final_Sigma: a cased letter comes before (skipping case-ignorables) and none after.
    static func isFinalSigma(_ s: [Unicode.Scalar], at i: Int) -> Bool {
        func casedLetter(in range: some Sequence<Int>) -> Bool {
            for j in range {
                let p = s[j].properties
                if p.isCaseIgnorable { continue }
                return p.isCased
            }
            return false
        }
        return casedLetter(in: stride(from: i - 1, through: 0, by: -1)) && !casedLetter(in: (i + 1)..<s.count)
    }

    /// The branch a ticket uses (`branch`, once its worktree exists) or will use when work starts
    /// (`requestedBranch`, else harness/<key>). Only meaningful when the ticket gets a worktree.
    public static func plannedBranch(key: String, branch: String?, requestedBranch: String?) -> String {
        branch ?? requestedBranch ?? harnessBranch(key)
    }

    public static func plannedBranch(_ ticket: Ticket) -> String {
        plannedBranch(key: ticket.key, branch: ticket.branch, requestedBranch: ticket.requestedBranch.optional)
    }

    // MARK: Validation

    /// Why `name` isn't a valid branch name, or nil when it is (`git check-ref-format --branch`).
    public static func branchNameError(_ name: String) -> String? {
        let s = Array(name.unicodeScalars)
        if s.isEmpty { return "a branch name can't be empty" }
        if name == "@" || name == "HEAD" { return "\"\(name)\" isn't a branch name" }
        if s.first == "-" { return "a branch name can't start with -" }
        if s.first == "/" || s.last == "/" { return "a branch name can't start or end with /" }
        if s.last == "." { return "a branch name can't end with ." }
        if contains(s, ["/", "/"]) { return "a branch name can't contain //" }
        if contains(s, [".", "."]) { return "a branch name can't contain .." }
        if contains(s, ["@", "{"]) { return "a branch name can't contain @{" }
        if s.contains(where: isForbidden) {
            return "a branch name can't contain spaces, control characters or any of ~ ^ : ? * [ \\"
        }
        for part in s.split(separator: "/", omittingEmptySubsequences: false) {
            if part.first == "." { return "no part of a branch name can start with ." }
            if part.count >= 5, Array(part.suffix(5)) == [".", "l", "o", "c", "k"] {
                return "no part of a branch name can end with .lock"
            }
        }
        return nil
    }

    /// `/[\x00-\x20\x7f~^:?*[\\]/`
    static func isForbidden(_ c: Unicode.Scalar) -> Bool {
        c.value <= 0x20 || c.value == 0x7F || "~^:?*[\\".unicodeScalars.contains(c)
    }

    static func contains(_ s: [Unicode.Scalar], _ needle: [Unicode.Scalar]) -> Bool {
        guard s.count >= needle.count else { return false }
        for i in 0...(s.count - needle.count) where Array(s[i..<(i + needle.count)]) == needle { return true }
        return false
    }

    /// JS truthiness for an optional string: nil and "" are both unset.
    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}
