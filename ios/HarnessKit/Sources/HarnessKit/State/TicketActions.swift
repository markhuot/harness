import Foundation

// The actions a ticket offers right now, as data: the ticket screen's buttons and its More menu
// and the board card's context menu all read this list, so their gates (status, conductor-managed,
// dependencies, busy, compacting) can't drift apart. The Mac keeps the same list in
// app/src/renderer/state/ticketActions.ts.
//
// Disabled placeholders ("Working…", "Starts automatically", "Restarts at …") aren't actions and
// aren't here: the ticket screen draws those itself.

/// One thing a ticket can be asked to do.
public enum TicketAction: Equatable, Sendable {
    /// "Start work", or "Approve plan" while the planning run is going.
    case start(approvePlan: Bool)
    /// Approve with the preselected action (`primary`); `choices` are every way to approve, the last
    /// one approving without an action. `managedReason` is set when a conductor approves in the
    /// human's place (the item is then disabled).
    case approve(title: String, primary: Approve.Request, choices: [Approve.MenuChoice], managedReason: String?)
    case requestChanges
    case reopen
    /// "Run agent review" / "Re-run agent review".
    case rerunAgentReview(title: String)
    case moveToDone
    case cancelRun
    case delete

    public var title: String {
        switch self {
        case let .start(approvePlan): approvePlan ? "Approve plan" : "Start work"
        case let .approve(title, _, _, _): title
        case .requestChanges: "Request changes"
        case .reopen: "Re-open"
        case let .rerunAgentReview(title): title
        case .moveToDone: "Move to done"
        case .cancelRun: "Cancel run"
        case .delete: "Delete ticket"
        }
    }

    /// Cancel run and Delete ticket are marked destructive.
    public var isDestructive: Bool {
        switch self {
        case .cancelRun, .delete: true
        default: false
        }
    }
}

/// An action and whether it can be used now. The ticket screen draws a disabled one greyed out; a
/// card menu leaves it out.
public struct TicketActionItem: Equatable, Sendable {
    public var action: TicketAction
    public var enabled: Bool

    public init(_ action: TicketAction, enabled: Bool = true) {
        self.action = action
        self.enabled = enabled
    }
}

public struct TicketActionSet: Equatable, Sendable {
    /// The status action and Approve / Request changes / Re-open: the ticket screen's button row.
    public var primary: [TicketActionItem]
    /// The More (…) menu's items, in order.
    public var more: [TicketActionItem]

    /// Everything a card menu offers: the enabled items, primary first.
    public var enabledActions: [TicketAction] {
        (primary + more).filter(\.enabled).map(\.action)
    }
}

public enum TicketActions {
    /// What `ticket` offers now. `deps` are its dependencies' states, `parent` its parent ticket
    /// (a managing conductor), `settingsBaseBranch` the app's base branch setting.
    public static func set(for ticket: Ticket, project: Project?, parent: Ticket?, deps: [DepState], settingsBaseBranch: String?) -> TicketActionSet {
        // A draft isn't launched: it offers nothing here (the card's menu offers Discard).
        guard ticket.draft != true else { return TicketActionSet(primary: [], more: []) }
        // While the session compacts the service refuses ticket actions; Cancel run stays.
        let compacting = ticket.compacting == true
        var primary: [TicketActionItem] = []
        var more: [TicketActionItem] = []

        let start = Conductor.startState(ticket, deps)
        if start == .start || start == .approve {
            primary.append(TicketActionItem(.start(approvePlan: start == .approve), enabled: !compacting))
        }

        // Approving lands the work once both reviews pass; there's no separate Complete step. A
        // conductor's child keeps its (turned off) Approve once approved: the conductor lands it.
        let managedReason = Completion.managingConductor(ticket: ticket, parent: parent).map { Completion.conductorManagedReason(conductorKey: $0.key) }
        if ticket.status == .review && (ticket.humanReview != .approved || managedReason != nil) {
            // A ticket on its base branch offers no merge or pull request, only clean up.
            let opts = Completion.completionOptions(ticket: ticket, project: project, parent: parent, settingsBaseBranch: settingsBaseBranch)
            primary.append(TicketActionItem(
                .approve(title: Completion.approveLabel(opts) ?? "Approve",
                         primary: Approve.primaryApproveRequest(opts, ticket: ticket),
                         choices: Approve.approveMenuChoices(opts),
                         managedReason: managedReason),
                enabled: managedReason == nil && !compacting))
        }
        if ticket.status == .review && ticket.humanReview != .approved {
            primary.append(TicketActionItem(.requestChanges, enabled: !compacting))
        }
        if ticket.status == .done {
            primary.append(TicketActionItem(.reopen, enabled: !compacting))
        }

        if ticket.status == .review {
            more.append(TicketActionItem(.rerunAgentReview(title: TicketDetailLogic.agentReviewButton(ticket.agentReview)), enabled: !ticket.busy && !compacting))
        }
        if TicketDetailLogic.offersMarkDone(ticket) {
            more.append(TicketActionItem(.moveToDone, enabled: !compacting))
        }
        if ticket.busy {
            more.append(TicketActionItem(.cancelRun))
        }
        more.append(TicketActionItem(.delete, enabled: !compacting))
        return TicketActionSet(primary: primary, more: more)
    }
}
