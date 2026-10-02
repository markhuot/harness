import Foundation

// Port of shared/src/state/branches.ts. Branch fields in the apps (the branch pickers on New
// session and ticket details, base-branch fields in settings, project settings and ticket
// details): the rows a picker shows for a query, the predicted harness/<key> branch, what a chosen
// name will do, and the "inherits" label. The service filters the branch list itself
// (GET /projects/:id/branches?q=); these only arrange what it returns. The rules themselves live
// in Logic/Branches.swift.
//
// JS string semantics: `===` compares code units, so names are compared scalar by scalar (Swift's
// `==` would treat NFC "café" and NFD "café" as equal); `trim()` and `\s` use JSCompat.

/// A row in a branch picker.
public enum BranchRow: Codable, Sendable, Equatable {
    /// The null pick: harness/<key> for a ticket branch, the inherited value for a base branch
    case `default`(label: String)
    case branch(BranchInfo)
    /// A typed name the list doesn't have
    case new(name: String, label: String)
    /// A typed name git wouldn't accept (not pickable)
    case invalid(label: String)

    public var kind: String {
        switch self {
        case .default: "default"
        case .branch: "branch"
        case .new: "new"
        case .invalid: "invalid"
        }
    }

    /// The branch name the row picks; nil for the default and invalid rows.
    public var value: String? {
        switch self {
        case .default, .invalid: nil
        case let .branch(info): info.name
        case let .new(name, _): name
        }
    }

    public var label: String {
        switch self {
        case let .default(label), let .new(_, label), let .invalid(label): label
        case let .branch(info): info.name
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, value, label, info }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let label = try c.decode(String.self, forKey: .label)
        switch try c.decode(String.self, forKey: .kind) {
        case "default": self = .default(label: label)
        case "branch": self = .branch(try c.decode(BranchInfo.self, forKey: .info))
        case "new": self = .new(name: try c.decode(String.self, forKey: .value), label: label)
        case "invalid": self = .invalid(label: label)
        case let other: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown branch row kind \(other)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        if let value { try c.encode(value, forKey: .value) } else { try c.encodeNil(forKey: .value) }
        try c.encode(label, forKey: .label)
        if case let .branch(info) = self { try c.encode(info, forKey: .info) }
    }
}

/// What a branch name picked or typed for a ticket will do when its worktree is made.
public enum BranchChoice: Codable, Sendable, Equatable {
    /// Nothing picked: a new harness/<key> branch from the base
    case `default`(name: String)
    /// An existing local branch, checked out as is (blocks while another worktree has it)
    case existing(name: String, checkedOutAt: String?)
    /// A name no branch has yet: created from the base
    case new(name: String)
    case invalid(name: String, error: String)
    /// The branch the project directory itself has checked out: a draft that picks it works right
    /// there, with no worktree (only offered while the ticket is a draft; see `branchChoice`).
    case checkout(name: String, path: String)

    public var name: String {
        switch self {
        case let .default(name), let .existing(name, _), let .new(name), let .invalid(name, _), let .checkout(name, _): name
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, name, checkedOutAt, error, path }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = try c.decode(String.self, forKey: .name)
        switch try c.decode(String.self, forKey: .kind) {
        case "default": self = .default(name: name)
        case "existing": self = .existing(name: name, checkedOutAt: try c.decodeIfPresent(String.self, forKey: .checkedOutAt))
        case "new": self = .new(name: name)
        case "invalid": self = .invalid(name: name, error: try c.decode(String.self, forKey: .error))
        case "checkout": self = .checkout(name: name, path: try c.decode(String.self, forKey: .path))
        case let other: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown branch choice kind \(other)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        switch self {
        case .default: try c.encode("default", forKey: .kind)
        case let .existing(_, at):
            try c.encode("existing", forKey: .kind)
            if let at { try c.encode(at, forKey: .checkedOutAt) } else { try c.encodeNil(forKey: .checkedOutAt) }
        case .new: try c.encode("new", forKey: .kind)
        case let .invalid(_, error):
            try c.encode("invalid", forKey: .kind)
            try c.encode(error, forKey: .error)
        case let .checkout(_, path):
            try c.encode("checkout", forKey: .kind)
            try c.encode(path, forKey: .path)
        }
    }
}

/// The line under a ticket's branch field (`branchChoiceHint`).
public struct BranchHint: Codable, Sendable, Equatable {
    public enum Tone: String, Codable, Sendable, Equatable {
        case plain, warn, error
    }

    public var text: String
    public var tone: Tone
    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }
}

extension Branches {
    /// The key the project's next native ticket will get: <KEY>-<nextSeq>, skipping keys already
    /// taken (the service does the same). A prediction: another client may create a ticket first.
    public static func predictedTicketKey(key: String, nextSeq: Int, isTaken: (String) -> Bool = { _ in false }) -> String {
        var n = nextSeq
        while isTaken("\(key)-\(n)") { n += 1 }
        return "\(key)-\(n)"
    }

    /// `predictedTicketKey` for a project.
    public static func predictedTicketKey(_ project: Project, isTaken: (String) -> Bool = { _ in false }) -> String {
        predictedTicketKey(key: project.key, nextSeq: project.nextSeq, isTaken: isTaken)
    }

    /// The default ticket-branch option: "New branch harness/<key>".
    public static func newTicketBranchLabel(_ key: String) -> String {
        "New branch \(harnessBranch(key))"
    }

    private static func sourceLabel(_ source: BaseBranchSource) -> String {
        switch source {
        case .ticket: "ticket"
        case .parent: "parent ticket's branch"
        case .project: "project default"
        case .settings: "app default"
        }
    }

    /// What an empty base-branch field inherits, e.g. "main (app default)" or "develop (project default)".
    public static func inheritedBaseLabel(_ resolved: ResolvedBaseBranch) -> String {
        "\(resolved.branch) (\(sourceLabel(resolved.source)))"
    }

    /// A picker's rows for `query`: the default first (hidden while a query is typed unless every
    /// word of it is in the default's label), then the service's matches in its order, then the
    /// typed name itself when the list doesn't have it exactly: a "new" row (labelled by
    /// `newLabel`) or, when git would refuse the name, an "invalid" row saying why.
    public static func branchRows(_ branches: [BranchInfo], query: String, defaultLabel: String, newLabel: (String) -> String) -> [BranchRow] {
        let q = JSCompat.trim(query)
        let words = jsLowerCase(q).unicodeScalars
            .split(whereSeparator: JSCompat.isWhitespace)
            .map(Array.init)
        var rows: [BranchRow] = []
        let def = Array(jsLowerCase(defaultLabel).unicodeScalars)
        if words.allSatisfy({ contains(def, $0) }) { rows.append(.default(label: defaultLabel)) }
        for b in branches { rows.append(.branch(b)) }
        if !q.isEmpty, !branches.contains(where: { jsEqual($0.name, q) }) {
            if let error = branchNameError(q) {
                rows.append(.invalid(label: "Not a valid branch name: \(error)"))
            } else {
                rows.append(.new(name: q, label: newLabel(q)))
            }
        }
        return rows
    }

    /// A row's id for keyboard focus: the default is "", a branch or new name its name. Invalid rows have none.
    public static func rowId(_ row: BranchRow) -> String? {
        if case .invalid = row { return nil }
        return row.value ?? ""
    }

    /// The pickable rows' ids, in order.
    public static func pickableIds(_ rows: [BranchRow]) -> [String] {
        rows.compactMap(rowId)
    }

    /// Paths compared as the same directory: trailing slashes don't count.
    public static func samePath(_ a: String?, _ b: String?) -> Bool {
        guard let a, !a.isEmpty, let b, !b.isEmpty else { return false }
        func norm(_ p: String) -> [Unicode.Scalar] {
            var s = Array(p.unicodeScalars)
            while s.last == "/" { s.removeLast() }
            return s.isEmpty ? ["/"] : s
        }
        return norm(a) == norm(b)
    }

    /// The branch the project directory has checked out, from a branch list (nil when it isn't listed).
    public static func checkoutBranch(_ branches: [BranchInfo], projectPath: String?) -> BranchInfo? {
        branches.first { samePath($0.checkedOutAt, projectPath) }
    }

    /// Classify `name` (nil or blank → the default branch) against the branches the service
    /// listed. `known` only needs to include the branch itself when it exists, e.g. the row it was
    /// picked from.
    public static func branchChoice(_ name: String?, defaultName: String, known: [BranchInfo], checkoutPath: String? = nil) -> BranchChoice {
        let n = nonEmpty(name.map(JSCompat.trim)) ?? defaultName
        let hit = known.first { jsEqual($0.name, n) }
        // `checkoutPath` (the project path) is passed only for a draft: there the project
        // directory's own branch means "no worktree" rather than "blocks on the main checkout".
        if let hit, let checkoutPath, !checkoutPath.isEmpty, samePath(hit.checkedOutAt, checkoutPath), let path = hit.checkedOutAt {
            return .checkout(name: n, path: path)
        }
        if let hit { return .existing(name: n, checkedOutAt: hit.checkedOutAt) }
        if jsEqual(n, defaultName) { return .default(name: n) }
        if let error = branchNameError(n) { return .invalid(name: n, error: error) }
        return .new(name: n)
    }

    /// The line under a ticket's branch field. `base` is the resolved base branch. `tone` is
    /// `.warn` when the ticket would block (the branch is checked out in another worktree),
    /// `.error` for a bad name.
    public static func branchChoiceHint(_ choice: BranchChoice, base: String) -> BranchHint {
        switch choice {
        case .default:
            return BranchHint(text: "A new branch, created from \(base) when work starts.", tone: .plain)
        case let .new(name):
            return BranchHint(text: "\(name) doesn't exist yet. It will be created from \(base) when work starts.", tone: .plain)
        case let .invalid(_, error):
            return BranchHint(text: "Not a valid branch name: \(error).", tone: .error)
        case let .checkout(name, path):
            return BranchHint(text: "Works directly in \(tildify(path)) on \(name), with no worktree.", tone: .plain)
        case let .existing(_, checkedOutAt):
            if let at = nonEmpty(checkedOutAt) {
                return BranchHint(text: "Checked out in \(tildify(at)). The ticket will block when it starts unless that worktree lets go of it.", tone: .warn)
            }
            return BranchHint(text: "An existing branch: the ticket's worktree checks it out as is.", tone: .plain)
        }
    }

    /// Whether the ticket works (or will work) in a worktree of its own, so it has a branch to show.
    public static func ticketHasBranch(_ ticket: Ticket, project: Project?) -> Bool {
        if nonEmpty(ticket.branch) != nil { return true }
        guard let project, project.isGit != false else { return false }
        return ticket.useWorktree.optional ?? project.useWorktrees
    }

    /// Whether the ticket's branch can still be picked (PATCH /tickets/:key `branch`): only before
    /// its worktree exists. Afterwards its agent moves it with the update_branch tool.
    public static func canChangeBranch(_ ticket: Ticket, project: Project?) -> Bool {
        ticket.status != .done && nonEmpty(ticket.workdir) == nil && ticketHasBranch(ticket, project: project)
    }

    // MARK: JS helpers

    /// `===` on strings: code-unit (here: scalar) equality, not canonical equivalence.
    static func jsEqual(_ a: String, _ b: String) -> Bool {
        a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }

    /// format.ts `tildify`: ~/… for paths under a macOS home directory (`/^\/Users\/[^/]+/`).
    static func tildify(_ path: String) -> String {
        let s = Array(path.unicodeScalars)
        let prefix = Array("/Users/".unicodeScalars)
        guard s.count > prefix.count, Array(s[0..<prefix.count]) == prefix, s[prefix.count] != "/" else { return path }
        var end = prefix.count
        while end < s.count, s[end] != "/" { end += 1 }
        var out = String.UnicodeScalarView()
        out.append("~")
        out.append(contentsOf: s[end...])
        return String(out)
    }
}
