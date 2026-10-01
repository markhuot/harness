import Foundation

// The branches of the ticket detail screen (mobile/src/screens/TicketDetail.tsx, TicketTabs.tsx,
// Approval.tsx) that are worth testing without a screen: which header actions and sheets apply,
// the labels its rows show, and the runs list. The views in Harness/Features/Ticket read these.

public enum TicketDetailLogic {
    /// JS `text.trim()`, for the screen's "is there anything to send" checks.
    public static func trim(_ s: String) -> String { JSCompat.trim(s) }

    // MARK: Header

    /// The More menu's "Mark done": not on a done ticket, and not in review, where the Approve menu's
    /// "Approve and take no action" does it (and records the approval).
    public static func offersMarkDone(_ t: Ticket) -> Bool {
        t.status != .done && t.status != .review
    }

    /// "#12" from a GitHub-style pull request URL (`/\/pull\/(\d+)/`), nil when it has no number.
    public static func pullRequestNumber(_ url: String) -> String? {
        let s = Array(url.unicodeScalars)
        let marker = Array("/pull/".unicodeScalars)
        guard s.count > marker.count else { return nil }
        for i in 0...(s.count - marker.count) where Array(s[i..<(i + marker.count)]) == marker {
            let digits = s[(i + marker.count)...].prefix { ("0"..."9").contains($0) }
            if !digits.isEmpty { return String(String.UnicodeScalarView(digits)) }
        }
        return nil
    }

    /// The pull request badge's text: "PR #12", or "Pull request" without a number.
    public static func pullRequestBadge(_ url: String) -> String {
        pullRequestNumber(url).map { "PR #\($0)" } ?? "Pull request"
    }

    /// The Details row's link text: the URL without its scheme (`/^https?:\/\//`).
    public static func pullRequestShort(_ url: String) -> String {
        for scheme in ["https://", "http://"] where url.unicodeScalars.starts(with: scheme.unicodeScalars) {
            return String(String.UnicodeScalarView(url.unicodeScalars.dropFirst(scheme.unicodeScalars.count)))
        }
        return url
    }

    // MARK: Review actions

    /// The Complete button's accessibility label, which says why it's disabled.
    public static func completeButtonLabel(ready: Bool, busy: Bool) -> String {
        if !ready { return "Complete (needs both agent and human approval)" }
        if busy { return "Complete (an agent run is in progress)" }
        return "Complete"
    }

    /// The agent review button: "Run agent review" after it was skipped, else "Re-run agent review".
    public static func agentReviewButton(_ state: ReviewState) -> String {
        state == .skipped ? "Run agent review" : "Re-run agent review"
    }

    /// The approve/complete menus' message for a child on its parent's branch.
    public static func parentBranchMessage(_ opts: Completion.Options) -> String? {
        guard let branch = opts.parentBranch, !branch.isEmpty else { return nil }
        return "It merges into \(branch), its parent's branch."
    }

    /// The toast after a Complete menu row: none marks the ticket done, an action queues a run.
    public static func completeMenuToast(_ choice: Approve.Choice, label: String) -> String {
        choice == .none ? "\(label) marked done" : "Completion run queued"
    }

    /// The Complete sheet's "When approved" choice: both reviews passed and nothing completes it on
    /// its own (no auto-complete, not a child on its parent's branch), with more than one action.
    public static func completeSheetChooses(ready: Bool, autoComplete: Bool, opts: Completion.Options) -> Bool {
        ready && !autoComplete && (opts.parentBranch ?? "").isEmpty && opts.actions.count > 1
    }

    /// The Complete sheet's first pick: the menu's action when the ticket offers it, else the default.
    public static func completeSheetInitial(_ requested: CompletionAction?, opts: Completion.Options) -> CompletionAction {
        if let requested, opts.actions.contains(requested) { return requested }
        return opts.defaultAction
    }

    /// "The agent finalizes the work: …, cleans up, and marks the ticket done."
    public static func completeSheetText(_ action: CompletionAction, opts: Completion.Options) -> String {
        let what: String
        if let branch = opts.parentBranch, !branch.isEmpty {
            what = "merges the branch into \(branch)"
        } else {
            switch action {
            case .merge: what = "merges the worktree branch"
            case .pr: what = "pushes the branch and opens a pull request"
            default: what = "follows your instructions"
            }
        }
        return "The agent finalizes the work: \(what), cleans up, and marks the ticket done."
    }

    /// The Complete sheet's Complete button: a custom action that the sheet (or the menu) chose needs
    /// instructions.
    public static func completeSheetCanSubmit(action: CompletionAction, explicit: Bool, instructions: String) -> Bool {
        !(action == .custom && explicit && JSCompat.trim(instructions).isEmpty)
    }

    /// The "Approve and…" sheet's starting text: the instructions of an earlier custom approval.
    public static func approveCustomInitial(_ t: Ticket) -> String {
        t.completionAction.optional == .custom ? (t.completionInstructions.optional ?? "") : ""
    }

    // MARK: Approval card

    /// The card's second line: the request's summary, the tool's description, or a generic nudge.
    public static func approvalSubtitle(_ a: PendingApproval, description: String?) -> String {
        a.summary ?? description ?? "Approve to let this run continue."
    }

    /// Who decided to ask: "Auto-mode classifier" or "Permission policy".
    public static func approvalReasonSource(_ source: PermissionSource?) -> String {
        source == .classifier ? "Auto-mode classifier" : "Permission policy"
    }

    /// The input the primary block leaves out, as `JSON.stringify(rest, null, 2)`.
    public static func approvalRestJSON(_ rest: [String: JSONValue]) -> String {
        JSJSON.stringify(.object(rest), indent: 2)
    }

    /// "Show other input" / "Hide input".
    public static func approvalRestToggle(showing: Bool, hasPrimary: Bool) -> String {
        "\(showing ? "Hide" : "Show") \(hasPrimary ? "other input" : "input")"
    }

    // MARK: Tabs

    /// A summary's author as the list names it.
    public static func authorLabel(_ a: SummaryAuthor) -> String {
        switch a {
        case .agent: "Agent"
        case .human: "You"
        default: "Harness"
        }
    }

    /// "1 ticket waiting on you" / "3 tickets waiting on you".
    public static func waitingOnYou(_ n: Int) -> String {
        "\(n) ticket\(n == 1 ? "" : "s") waiting on you"
    }

    /// The session's runs, newest first.
    public static func runs(_ state: BoardState, sessionId: String) -> [Run] {
        state.runs.values.filter { $0.sessionId == sessionId }.sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.id > $1.id }
    }

    /// A run's time column: its duration once it ran ("12s", at least 1s), else when it was queued.
    public static func runTime(_ r: Run, now: Double) -> String {
        if let start = r.startedAt, let end = r.endedAt, start != 0, end != 0 {
            return "\(max(1, Int(JSCompat.round((end - start) / 1000))))s"
        }
        return Format.relativeTime(r.createdAt, now: now)
    }

    /// A run's second line: its error, or its prompt's first line.
    public static func runDetail(_ r: Run) -> String {
        if let e = r.error { return e }
        return String(String.UnicodeScalarView(r.prompt.unicodeScalars.prefix { $0 != "\n" }))
    }

    /// "Also linked to JIRA-62" on a linked ticket, else "Linked to remote ID MH-62" (a native key
    /// other tickets carry as their remote ID).
    public static func relatedHeading(_ t: Ticket) -> String {
        if let ref = t.externalRef { return "Also linked to \(ref.key)" }
        return "Linked to remote ID \(t.key)"
    }

    /// The External row's source: "set by hand" or "via jira".
    public static func externalSource(_ ref: ExternalRef) -> String {
        ref.source == "manual" ? "set by hand" : "via \(ref.source)"
    }

    /// The toast after a settings patch: linking or unlinking a remote ID says so.
    public static func patchToast(_ patch: UpdateTicketBody) -> String? {
        switch patch.externalRef {
        case .null: "Remote ID unlinked"
        case let .value(ref): "Linked to \(ref.key)"
        case .absent: nil
        }
    }

    /// The Remote ID screen's line: "One ticket is linked to it." / "3 tickets are linked to it."
    public static func remoteIdCount(_ n: Int) -> String {
        n == 1 ? "One ticket is linked to it." : "\(n) tickets are linked to it."
    }
}
