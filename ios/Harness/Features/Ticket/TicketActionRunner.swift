import HarnessKit
import SwiftUI

/// Runs a ticket's actions (HarnessKit's `TicketActions`) for whoever offers them: the ticket
/// screen's buttons and More menu, and the board card's context menu. An action that needs input
/// (notes, instructions, a confirmation) parks it in `prompt` / `confirm`, and the screen hosts
/// `TicketActionHost` to present it, since a context menu can't present a sheet itself. The board
/// hosts one for the whole screen, not one per card.
@MainActor
@Observable
final class TicketActionRunner {
    /// A sheet asking for input before an action goes out.
    struct Prompt: Identifiable {
        enum Kind { case requestChanges, reopen, unblock, approveCustom }
        let id = UUID()
        let kind: Kind
        let ticket: Ticket
    }

    var prompt: Prompt?
    var confirm: Confirmation?

    /// Run `action` on `ticket`. A failure plays the error haptic (`Actions`), as on the ticket
    /// screen. `onDeleted` runs after a confirmed delete went through (the ticket screen goes back).
    func run(_ action: TicketAction, ticket: Ticket, api: HarnessClient?, actions: Actions, onDeleted: ((String) -> Void)? = nil) {
        switch action {
        case .start:
            haptic(.success)
            perform(api, ticket, actions) { try await $0.startTicket($1) }
        case let .approve(_, primary, _, _):
            haptic(.success)
            send(primary, api, ticket, actions)
        case .unblock:
            prompt = Prompt(kind: .unblock, ticket: ticket)
        case .requestChanges:
            prompt = Prompt(kind: .requestChanges, ticket: ticket)
        case .reopen:
            prompt = Prompt(kind: .reopen, ticket: ticket)
        case .rerunAgentReview:
            perform(api, ticket, actions) { try await $0.rerunAgentReview($1) }
        case .moveToDone:
            perform(api, ticket, actions) { try await $0.completeTicket($1, CompleteBody(skipAgent: true)) }
        case .cancelRun:
            perform(api, ticket, actions) { try await $0.cancelTicket($1) }
        case .delete:
            let key = ticket.key
            confirm = Confirmation(title: "Delete \(Keys.keyLabel(ticket))?", message: "Its transcript, spec history and activity are removed too.", action: "Delete") {
                guard let api else { return }
                Task {
                    if await actions.run({ try await api.deleteTicket(key) }) != nil { onDeleted?(key) }
                }
            }
        }
    }

    /// One of the Approve submenu's choices: "Approve and…" asks for instructions first.
    func approve(_ choice: Approve.Choice, ticket: Ticket, api: HarnessClient?, actions: Actions) {
        if choice == .action(.custom) {
            prompt = Prompt(kind: .approveCustom, ticket: ticket)
            return
        }
        haptic(.success)
        send(Approve.approveRequest(choice), api, ticket, actions)
    }

    private func send(_ request: Approve.Request, _ api: HarnessClient?, _ ticket: Ticket, _ actions: Actions) {
        switch request {
        case let .review(body): perform(api, ticket, actions) { try await $0.humanReview($1, body) }
        case let .complete(body): perform(api, ticket, actions) { try await $0.completeTicket($1, body) }
        }
    }

    private func perform<T: Sendable>(_ api: HarnessClient?, _ ticket: Ticket, _ actions: Actions, _ fn: @escaping @MainActor (HarnessClient, String) async throws -> T) {
        guard let api else { return }
        let key = ticket.key
        actions.perform { _ = try await fn(api, key) }
    }
}

/// Presents what a `TicketActionRunner` asks for: the notes and instructions sheets and the delete
/// confirmation.
struct TicketActionHost: ViewModifier {
    @Bindable var runner: TicketActionRunner

    func body(content: Content) -> some View {
        content
            .sheet(item: $runner.prompt) { prompt in
                switch prompt.kind {
                case .requestChanges: TicketDetailNotesSheet(ticket: prompt.ticket)
                case .reopen: TicketDetailNotesSheet(ticket: prompt.ticket, reopen: true)
                case .unblock: TicketDetailNotesSheet(ticket: prompt.ticket, unblock: true)
                case .approveCustom: TicketDetailApproveCustomSheet(ticket: prompt.ticket)
                }
            }
            .confirmation($runner.confirm)
    }
}

extension TicketAction {
    /// The SF Symbol beside the action in a menu.
    var symbol: String {
        switch self {
        case .start: "play"
        case .approve: "checkmark"
        case .unblock: "play"
        case .requestChanges: "pencil"
        case .reopen: "arrow.counterclockwise"
        case .rerunAgentReview: "arrow.clockwise"
        case .moveToDone: "checkmark.circle"
        case .cancelRun: "stop.circle"
        case .delete: "trash"
        }
    }
}
