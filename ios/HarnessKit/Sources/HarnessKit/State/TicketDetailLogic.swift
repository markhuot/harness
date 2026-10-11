import Foundation

// The branches of the ticket detail screen (its header, tabs and approval sheet) that are worth
// testing without a screen: which header actions and sheets apply,
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

    /// The pull request's title when it has one (trimmed; "" counts as none), else nil.
    public static func pullRequestTitle(_ link: PullRequestLink) -> String? {
        let title = link.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? nil : title
    }

    /// The Details row's subtitle: the title, or "No title" when the pull request has none.
    public static func pullRequestSubtitle(_ link: PullRequestLink) -> String {
        pullRequestTitle(link) ?? "No title"
    }

    /// The hero badge's VoiceOver label: "Pull request #12: Split the secrets out", naming the title
    /// when there is one. Without a number it's "Pull request" plus the title.
    public static func pullRequestAccessibilityLabel(_ link: PullRequestLink) -> String {
        let base = pullRequestNumber(link.url).map { "Pull request #\($0)" } ?? "Pull request"
        return pullRequestTitle(link).map { "\(base): \($0)" } ?? base
    }

    /// The More menu's item for a pull request: its title, else "Open pull request #12".
    public static func pullRequestMenuTitle(_ link: PullRequestLink) -> String {
        pullRequestTitle(link) ?? (pullRequestNumber(link.url).map { "Open pull request #\($0)" } ?? "Open pull request")
    }

    // MARK: Review actions

    /// The agent review button: "Run agent review" after it was skipped, else "Re-run agent review".
    public static func agentReviewButton(_ state: ReviewState) -> String {
        state == .skipped ? "Run agent review" : "Re-run agent review"
    }

    /// The Approve button's accessibility label: its title, plus why it's disabled on a
    /// conductor-managed ticket.
    public static func approveButtonLabel(_ title: String, managedReason: String?) -> String {
        managedReason.map { "\(title) (\($0))" } ?? title
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

    /// An Activity entry's author as the list names it.
    public static func authorLabel(_ a: ActivityAuthor) -> String {
        switch a {
        case .agent: "Agent"
        case .human: "You"
        default: "Harness"
        }
    }

    // MARK: Composer

    /// The composer's placeholder: what a message does in the ticket's state ("Answer the agent…",
    /// "Send a follow-up…").
    public static func composerPlaceholder(_ t: Ticket) -> String {
        if t.compacting == true { return "Compacting…" }
        return Format.composerPlaceholder[t.status] ?? "Message the agent…"
    }

    // MARK: Message attachments

    /// Whether the composer offers its attach (+) button: not while a tool approval waits, since a
    /// message then answers the approval as a deny and the service refuses attachments with it.
    public static func acceptsMessageAttachments(_ t: Ticket) -> Bool {
        t.pendingApproval == nil
    }

    /// Whether Send goes: there's text or at least one attachment, nothing is still uploading, no
    /// send is in flight, and no attachment would go with a message that answers a waiting tool
    /// approval (the service refuses that).
    /// While the ticket's session compacts the service refuses messages, so Send is off.
    public static func canSendMessage(text: String, attachments: Int, uploading: Int, sending: Bool, approvalPending: Bool, compacting: Bool = false) -> Bool {
        guard !sending, !compacting, uploading == 0 else { return false }
        if attachments > 0 { return !approvalPending }
        return !trim(text).isEmpty
    }

    /// "1 ticket waiting on you" / "3 tickets waiting on you".
    public static func waitingOnYou(_ n: Int) -> String {
        "\(n) ticket\(n == 1 ? "" : "s") waiting on you"
    }

    /// The session's runs, newest first.
    public static func runs(_ state: BoardState, sessionId: String) -> [Run] {
        state.runs.values.filter { $0.sessionId == sessionId }.sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.id > $1.id }
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

    /// The Remote ID screen's line: "One ticket is linked to it." / "3 tickets are linked to it."
    public static func remoteIdCount(_ n: Int) -> String {
        n == 1 ? "One ticket is linked to it." : "\(n) tickets are linked to it."
    }
}
